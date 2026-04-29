/**
 * voiceGateway — `/ws/voice` endpoint'i.
 *
 * Arşiv'in event sözlüğünü konuşur ama altta mevcut services/ai/* modüllerine
 * bağlanır:
 *   - STT: providers/* (default: openai-realtime → sttStreamService)
 *   - LLM: services/ai/chatOrchestrator (echo guard, moderation, language lock,
 *          filler audio, n8n LLM adapter)
 *   - TTS: services/ai/ttsPipeline (BunnyCDN cache + live HTTP stream + warm queue)
 *   - Viseme: services/ai/mouthCueService (remote) | rhubarb | elevenlabs
 *
 * Auth: utils/jwt.verifyToken + sessionService.getSessionById ownership check.
 */

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const { verifyToken } = require('../../utils/jwt');
const {
  getSessionById,
  reconcileStaleCall,
  touchSession
} = require('../ai/sessionService');
const { clearSessionSpeech } = require('../ai/echoGuard');
const { log, warn, debug } = require('../ai/logger');

const { createSttProvider } = require('./providers');
const { VoiceStreamError, isRecoverableError } = require('./errors');
const {
  createSessionState,
  markChunkProcessed,
  isChunkProcessed,
  clearVadTimer
} = require('./sessionState');
const { WebRtcTransport, hasWebRtcRuntime } = require('./webrtcTransport');
const ttsBridge = require('./bridges/ttsBridge');
const aiPipelineBridge = require('./bridges/aiPipelineBridge');
const visemeBridge = require('./bridges/visemeBridge');
const { resamplePcm16 } = require('./audioUtils');

// ─── Env helpers ──────────────────────────────────────────────────────────────

function isVoiceStreamingEnabled() {
  return String(process.env.VOICE_STREAMING_ENABLED || 'false').toLowerCase() === 'true';
}

function isVoiceDebugEnabled() {
  return String(process.env.VOICE_DEBUG_LOGS || 'false').toLowerCase() === 'true';
}

function voiceDebugLog(message) {
  if (isVoiceDebugEnabled()) {
    debug('[VOICE]', message);
  }
}

function envInt(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDefaultAudioConfig() {
  return {
    codec: process.env.VOICE_AUDIO_CODEC || 'pcm16le',
    sampleRate: envInt('VOICE_AUDIO_SAMPLE_RATE', 16000),
    channels: envInt('VOICE_AUDIO_CHANNELS', 1),
    frameMs: envInt('VOICE_AUDIO_FRAME_MS', 20)
  };
}

function isWebRtcEnabled() {
  return String(process.env.WEBRTC_ENABLED || 'false').toLowerCase() === 'true';
}

function getSttProviderName() {
  return String(process.env.STT_PROVIDER || 'openai-realtime').toLowerCase();
}

// ─── Frame helpers ────────────────────────────────────────────────────────────

function sendEvent(ws, type, payload = {}, requestId = null) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type,
    ts: Date.now(),
    requestId,
    payload
  }));
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_) {
    throw new VoiceStreamError('BAD_JSON', 'Geçersiz JSON payload', { recoverable: true });
  }
}

function extractToken(request, parsedUrl) {
  const auth = request.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  const queryToken = parsedUrl.searchParams.get('token');
  if (queryToken) return queryToken;
  const protocolToken = request.headers['x-auth-token'];
  return protocolToken || null;
}

function normalizeChunkPayload(payload) {
  const utteranceId = payload.utteranceId || 'default';
  const chunkSeq = Number(payload.chunkSeq);
  if (!Number.isInteger(chunkSeq) || chunkSeq < 0) {
    throw new VoiceStreamError('BAD_CHUNK_SEQ', 'chunkSeq integer olmalı', { recoverable: true });
  }
  if (!payload.audioBase64 && !payload.textHint) {
    throw new VoiceStreamError('BAD_AUDIO_CHUNK', 'audioBase64 veya textHint gerekli', { recoverable: true });
  }
  const audio = payload.audio || {};
  const codec = (audio.codec || payload.codec || 'pcm16le').toLowerCase();
  const sampleRate = Number(audio.sampleRate || payload.sampleRate || 16000);
  const channels = Number(audio.channels || payload.channels || 1);
  const frameMs = Number(audio.frameMs || payload.frameMs || 20);
  if (codec !== 'pcm16le') {
    const err = new VoiceStreamError('UNSUPPORTED_CODEC', `Desteklenmeyen codec: ${codec}`, { recoverable: false });
    err.stage = 'stt';
    throw err;
  }
  if (![8000, 16000, 24000, 48000].includes(sampleRate)) {
    const err = new VoiceStreamError('BAD_SAMPLE_RATE', `sampleRate desteklenmiyor: ${sampleRate}`, { recoverable: true });
    err.stage = 'stt';
    throw err;
  }
  if (channels !== 1) {
    const err = new VoiceStreamError('BAD_CHANNELS', 'channels=1 olmalı', { recoverable: false });
    err.stage = 'stt';
    throw err;
  }
  return {
    utteranceId,
    chunkSeq,
    audioBase64: payload.audioBase64 || null,
    textHint: payload.textHint || null,
    language: payload.language || 'tr-TR',
    audio: { codec, sampleRate, channels, frameMs }
  };
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

async function initializeSession(context, payload) {
  const { sessionRow, userRow } = context;
  const defaultLanguage = process.env.VOICE_DEFAULT_LANGUAGE || sessionRow.language || 'tr-TR';
  const requestedAudio = payload.audio || {};
  const defaultAudio = getDefaultAudioConfig();
  const audio = {
    codec: (requestedAudio.codec || defaultAudio.codec || 'pcm16le').toLowerCase(),
    sampleRate: Number(requestedAudio.sampleRate || defaultAudio.sampleRate || 16000),
    channels: Number(requestedAudio.channels || defaultAudio.channels || 1),
    frameMs: Number(requestedAudio.frameMs || defaultAudio.frameMs || 20)
  };
  if (audio.codec !== 'pcm16le') {
    const err = new VoiceStreamError('UNSUPPORTED_CODEC', `Desteklenmeyen codec: ${audio.codec}`, { recoverable: false });
    err.stage = 'session';
    throw err;
  }
  if (audio.channels !== 1) {
    const err = new VoiceStreamError('BAD_CHANNELS', 'channels=1 olmalı', { recoverable: false });
    err.stage = 'session';
    throw err;
  }

  // session.callLockedLanguage authoritative; payload.language sadece hint.
  const session = createSessionState({
    sessionId: sessionRow.id,
    userId: sessionRow.userId,
    conversationId: sessionRow.id,
    language: sessionRow.callLockedLanguage || sessionRow.language || defaultLanguage,
    sampleRate: audio.sampleRate
  });
  session.audio = audio;
  session.transport = (payload.transport || 'ws').toLowerCase();
  session.webrtc = { audioFrameSeq: 0 };
  session.finalizedUtterances = new Set();
  session.finalizingUtterances = new Set();
  session.personaId = sessionRow.personaId;
  session.callLockedLanguage = sessionRow.callLockedLanguage || null;
  session.activeMode = sessionRow.activeMode || 'voice_call';

  const providerName = getSttProviderName();
  const provider = createSttProvider({
    provider: providerName,
    language: session.language,
    sampleRate: session.sampleRate
  });

  // OpenAiRealtimeSttProvider session/user objelerini bekliyor; diğer
  // provider'lar için zararsız ek data.
  await provider.startSession({
    sessionId: session.sessionId,
    userId: session.userId,
    conversationId: session.conversationId,
    language: session.language,
    sessionRow,
    userRow
  });

  // VAD silence timer'ı sadece OpenAI Realtime dışı provider'larda anlamlı —
  // realtime'da server-VAD finalize ediyor.
  session.vad.enabled = providerName !== 'openai-realtime'
    && providerName !== 'openai'
    && providerName !== 'realtime';
  session.vad.silenceMs = envInt('VOICE_VAD_SILENCE_MS', session.vad.silenceMs || 900);

  context.session = session;
  context.provider = provider;
}

function setupProviderListeners(ws, context) {
  context.provider.on('partial', (data) => {
    sendEvent(ws, 'stt.partial', {
      sessionId: context.session.sessionId,
      ...data
    });
  });

  context.provider.on('final', async (data) => {
    const transcript = String(data?.transcript || '').trim();
    const noSpeech = data?.noSpeech === true || !transcript;
    const utteranceId = data?.utteranceId || context.session.activeUtteranceId || randomUUID();

    sendEvent(ws, 'stt.final', {
      sessionId: context.session.sessionId,
      utteranceId,
      language: data?.language,
      transcript,
      noSpeech
    });

    if (noSpeech) {
      context.session.turnState = 'listening';
      sendEvent(ws, 'turn.state', {
        sessionId: context.session.sessionId,
        state: context.session.turnState,
        reason: 'stt_no_speech'
      });
      return;
    }

    context.session.turnState = 'thinking';
    sendEvent(ws, 'turn.state', {
      sessionId: context.session.sessionId,
      state: context.session.turnState,
      reason: 'stt_final'
    });

    // chatOrchestrator pipeline (echo guard, moderation, language lock, filler, LLM)
    const pipelineResult = await aiPipelineBridge.processFinalTranscript({
      session: context.sessionRow,
      user: context.userRow,
      transcript,
      utteranceId,
      language: data?.language,
      sendEvent: (type, payload) => sendEvent(ws, type, payload),
      onAssistantText: async (assistantText) => {
        if (!assistantText) return;
        context.session.turnState = 'speaking';
        context.session.aiSpeaking = true;
        context.session.currentAiUtteranceId = utteranceId;
        sendEvent(ws, 'turn.state', {
          sessionId: context.session.sessionId,
          state: context.session.turnState,
          reason: 'tts_start'
        });

        try {
          await ttsBridge.streamAssistantText({
            session: {
              ...context.sessionRow,
              activeMode: context.session.activeMode
            },
            text: assistantText,
            utteranceId,
            sendEvent: (type, payload) => sendEvent(ws, type, payload),
            shouldAbort: () => !context.session.aiSpeaking,
            onCompleted: async ({ mouthCues }) => {
              if (visemeBridge.isVisemeBlockingEnabled()) {
                await visemeBridge.emitTimeline({
                  sendEvent: (type, payload) => sendEvent(ws, type, payload),
                  utteranceId,
                  text: assistantText,
                  voiceId: null,
                  preEnrichedMouthCues: mouthCues
                });
              } else {
                // background
                Promise.resolve().then(() =>
                  visemeBridge.emitTimeline({
                    sendEvent: (type, payload) => sendEvent(ws, type, payload),
                    utteranceId,
                    text: assistantText,
                    voiceId: null,
                    preEnrichedMouthCues: mouthCues
                  })
                ).catch((err) => warn('voiceGateway viseme background failed', err.message));
              }
            }
          });
        } catch (err) {
          warn('voiceGateway TTS pipeline failed', err.message);
          sendEvent(ws, 'error', {
            code: 'TTS_PIPELINE_ERROR',
            message: err.message,
            retryable: false,
            stage: 'tts'
          });
        } finally {
          context.session.aiSpeaking = false;
          context.session.currentAiUtteranceId = null;
          context.session.turnState = 'listening';
          sendEvent(ws, 'turn.state', {
            sessionId: context.session.sessionId,
            state: context.session.turnState,
            reason: 'tts_end'
          });
        }
      }
    });

    // Bug fix: STT validation reddi (locked_language_mismatch, echo guard,
    // moderation block, vs.) durumunda assistant_done HİÇ fire etmiyor →
    // onAssistantText callback'i çağrılmıyor → turn.state thinking'de takılıyor.
    // pipelineResult.handled=false ise turn'ü manuel olarak listening'e döndür.
    if (!pipelineResult || pipelineResult.handled === false) {
      context.session.turnState = 'listening';
      sendEvent(ws, 'turn.state', {
        sessionId: context.session.sessionId,
        state: context.session.turnState,
        reason: pipelineResult?.rejected ? 'stt_rejected' : 'pipeline_no_response'
      });
    }
  });

  context.provider.on('error', (err) => {
    sendEvent(ws, 'error', {
      code: err?.code || 'STT_ERROR',
      message: err?.message || 'STT error',
      retryable: isRecoverableError(err),
      stage: 'stt'
    });
  });
}

function interruptAiIfSpeaking(ws, context, reason = 'user_speaking') {
  if (!context?.session?.aiSpeaking) return;
  const interruptedUtteranceId = context.session.currentAiUtteranceId;
  context.session.aiSpeaking = false;
  context.session.currentAiUtteranceId = null;
  context.session.turnState = 'listening';
  sendEvent(ws, 'tts.stop', {
    utteranceId: interruptedUtteranceId,
    reason
  });
  sendEvent(ws, 'tts.chunk', {
    utteranceId: interruptedUtteranceId,
    chunkSeq: -1,
    audioBase64: '',
    isLast: true,
    interrupted: true,
    reason
  });
  sendEvent(ws, 'tts.end', {
    utteranceId: interruptedUtteranceId,
    interrupted: true,
    reason
  });
  sendEvent(ws, 'ai.interrupted', {
    utteranceId: interruptedUtteranceId,
    reason
  });
  sendEvent(ws, 'turn.state', {
    sessionId: context.session.sessionId,
    state: context.session.turnState,
    reason
  });
}

// ─── Audio chunk ingest ───────────────────────────────────────────────────────

async function ingestAudioChunk(ws, context, normalized, requestId = null) {
  if (isChunkProcessed(context.session, normalized.utteranceId, normalized.chunkSeq)) {
    sendEvent(ws, 'ack', {
      ackType: 'audio.chunk',
      utteranceId: normalized.utteranceId,
      chunkSeq: normalized.chunkSeq,
      duplicate: true
    }, requestId);
    return;
  }

  markChunkProcessed(context.session, normalized.utteranceId, normalized.chunkSeq);
  context.session.lastChunkAt = Date.now();
  context.session.activeUtteranceId = normalized.utteranceId;
  context.session.audioChunkCount = (context.session.audioChunkCount || 0) + 1;

  let audioBytes = normalized.audioBytes || null;
  if (!audioBytes && normalized.audioBase64) {
    audioBytes = Buffer.from(normalized.audioBase64, 'base64');
  }

  await context.provider.pushAudioChunk({
    ...normalized,
    audioBytes
  });

  if (context.session.vad.enabled) {
    scheduleVadFinalization(ws, context, normalized.utteranceId);
  }

  sendEvent(ws, 'ack', {
    ackType: 'audio.chunk',
    utteranceId: normalized.utteranceId,
    chunkSeq: normalized.chunkSeq,
    duplicate: false
  }, requestId);
}

function scheduleVadFinalization(ws, context, utteranceId) {
  clearVadTimer(context.session);
  if (!context.session.vad.enabled) return;
  context.session.vad.timer = setTimeout(async () => {
    try {
      await finalizeUtterance(ws, context, utteranceId, 'silence_timeout');
    } catch (error) {
      sendEvent(ws, 'error', {
        code: error.code || 'VAD_FINALIZE_ERROR',
        message: error.message || 'VAD finalize hatası',
        retryable: isRecoverableError(error),
        stage: 'vad'
      });
    }
  }, context.session.vad.silenceMs);
}

async function finalizeUtterance(ws, context, utteranceId, reason = 'manual') {
  if (!utteranceId) return;
  clearVadTimer(context.session);

  if (context.session.finalizedUtterances?.has(utteranceId)) {
    voiceDebugLog(`finalize skipped (already) | utteranceId=${utteranceId} reason=${reason}`);
    return;
  }
  if (context.session.finalizingUtterances?.has(utteranceId)) {
    voiceDebugLog(`finalize skipped (in progress) | utteranceId=${utteranceId} reason=${reason}`);
    return;
  }

  context.session.finalizingUtterances?.add(utteranceId);
  context.session.activeUtteranceId = utteranceId;
  try {
    try {
      await context.provider.finalizeUtterance(utteranceId);
      context.session.finalizedUtterances?.add(utteranceId);
      sendEvent(ws, 'ack', {
        ackType: 'utterance.finalized',
        utteranceId,
        reason
      });
    } catch (error) {
      const isSttStageError = String(error?.code || '').startsWith('STT_');
      if (!isSttStageError) {
        throw error;
      }
      context.session.finalizedUtterances?.add(utteranceId);
      context.session.turnState = 'listening';
      sendEvent(ws, 'error', {
        code: error.code || 'STT_TRANSCRIBE_FAILED',
        message: error.message || 'STT transcribe failed',
        retryable: true,
        stage: 'stt'
      });
      sendEvent(ws, 'ack', {
        ackType: 'utterance.failed',
        utteranceId,
        reason,
        errorCode: error.code || 'STT_TRANSCRIBE_FAILED'
      });
      sendEvent(ws, 'turn.state', {
        sessionId: context.session.sessionId,
        state: context.session.turnState,
        reason: 'stt_failed'
      });
    }
  } finally {
    context.session.finalizingUtterances?.delete(utteranceId);
  }
}

// ─── Event router ─────────────────────────────────────────────────────────────

async function handleEvent(ws, context, message) {
  const { type, payload = {}, requestId = null } = message;
  if (!type) {
    throw new VoiceStreamError('MISSING_EVENT_TYPE', 'type alanı gerekli', { recoverable: true });
  }

  if (type === 'ping') {
    sendEvent(ws, 'pong', { ok: true }, requestId);
    return;
  }

  if (type === 'session.start') {
    await initializeSession(context, payload);
    log('[VOICE] session.start',
      `userId=${context.session.userId} sessionId=${context.session.sessionId} transport=${context.session.transport} language=${context.session.language}`);
    setupProviderListeners(ws, context);
    sendEvent(ws, 'session.ready', {
      sessionId: context.session.sessionId,
      userId: context.session.userId,
      conversationId: context.session.conversationId,
      language: context.session.language,
      personaId: context.session.personaId,
      transport: context.session.transport,
      audio: context.session.audio,
      sttProvider: getSttProviderName(),
      ttsProvider: 'elevenlabs',
      visemeProvider: visemeBridge.getProvider(),
      supportsWebRtc: isWebRtcEnabled(),
      webRtcRuntime: hasWebRtcRuntime()
    }, requestId);
    return;
  }

  if (!context.session || !context.provider) {
    throw new VoiceStreamError('SESSION_NOT_STARTED', 'Önce session.start gönderilmeli', { recoverable: true });
  }

  if (type === 'audio.chunk') {
    const normalized = normalizeChunkPayload(payload);
    await ingestAudioChunk(ws, context, normalized, requestId);
    return;
  }

  if (type === 'utterance.end') {
    await finalizeUtterance(ws, context, payload.utteranceId || context.session.activeUtteranceId, 'client_end');
    return;
  }

  if (type === 'vad.event') {
    const { utteranceId, isSpeech } = payload;
    if (isSpeech === true) {
      interruptAiIfSpeaking(ws, context, 'user_speech_detected');
    }
    if (isSpeech === false && context.session.vad.enabled) {
      await finalizeUtterance(ws, context, utteranceId || context.session.activeUtteranceId, 'vad_event');
    }
    sendEvent(ws, 'ack', { ackType: 'vad.event' }, requestId);
    return;
  }

  if (type === 'speech.start') {
    const utteranceId = payload.utteranceId || randomUUID();
    context.session.activeUtteranceId = utteranceId;
    interruptAiIfSpeaking(ws, context, 'speech.start');
    sendEvent(ws, 'ack', { ackType: 'speech.start', utteranceId }, requestId);
    return;
  }

  if (type === 'speech.stop') {
    const utteranceId = payload.utteranceId || context.session.activeUtteranceId;
    await finalizeUtterance(ws, context, utteranceId, 'speech.stop');
    return;
  }

  if (type === 'webrtc.offer') {
    if (!isWebRtcEnabled()) {
      const err = new VoiceStreamError('WEBRTC_DISABLED', 'WEBRTC_ENABLED=false', { recoverable: false });
      err.stage = 'session';
      throw err;
    }
    if (!hasWebRtcRuntime()) {
      const err = new VoiceStreamError('WEBRTC_RUNTIME_MISSING', 'wrtc modülü kurulu değil', { recoverable: false });
      err.stage = 'session';
      throw err;
    }
    if (!context.webrtcTransport) {
      context.webrtcTransport = new WebRtcTransport({
        onTrack: (track) => {
          sendEvent(ws, 'webrtc.track', {
            sessionId: context.session.sessionId,
            ...track
          });
        },
        onPcmFrame: async (frame) => {
          if (!context.session || !context.provider) return;
          const utteranceId = context.session.activeUtteranceId || `utt-${context.session.sessionId}`;
          context.session.webrtc.audioFrameSeq += 1;
          const inputSampleRate = Number(frame.sampleRate || context.session.sampleRate || 16000);
          let normalizedSampleRate = inputSampleRate;
          let normalizedAudioBytes = frame.audioBytes;
          if (inputSampleRate !== 16000) {
            normalizedAudioBytes = resamplePcm16(frame.audioBytes, inputSampleRate, 16000);
            normalizedSampleRate = 16000;
          }

          const normalized = {
            utteranceId,
            chunkSeq: context.session.webrtc.audioFrameSeq,
            audioBase64: null,
            textHint: null,
            language: context.session.language,
            audio: {
              codec: 'pcm16le',
              sampleRate: normalizedSampleRate,
              channels: frame.channels || 1,
              frameMs: context.session.audio?.frameMs || 20
            },
            audioBytes: normalizedAudioBytes
          };
          try {
            await ingestAudioChunk(ws, context, normalized, null);
          } catch (e) {
            sendEvent(ws, 'error', {
              code: e.code || 'WEBRTC_AUDIO_INGEST_ERROR',
              message: e.message || 'WebRTC audio ingest failed',
              retryable: isRecoverableError(e),
              stage: 'stt'
            });
          }
        }
      });
    }
    const sdp = payload?.sdp;
    if (!sdp) {
      throw new VoiceStreamError('BAD_WEBRTC_OFFER', 'sdp gerekli', { recoverable: true });
    }
    const answerSdp = await context.webrtcTransport.createAnswerFromOffer(sdp);
    sendEvent(ws, 'webrtc.answer', { sdp: answerSdp }, requestId);
    return;
  }

  if (type === 'webrtc.ice') {
    if (!context.webrtcTransport) {
      throw new VoiceStreamError('WEBRTC_NOT_STARTED', 'Önce webrtc.offer gönderilmeli', { recoverable: true });
    }
    await context.webrtcTransport.addIceCandidate(payload?.candidate || null);
    sendEvent(ws, 'ack', { ackType: 'webrtc.ice' }, requestId);
    return;
  }

  if (type === 'tts.request') {
    // Manuel TTS isteği; assistant_text payload'ından
    const text = String(payload?.text || '').trim();
    if (!text) {
      throw new VoiceStreamError('BAD_TTS_TEXT', 'text alanı gerekli', { recoverable: true });
    }
    const utteranceId = payload?.utteranceId || randomUUID();
    context.session.aiSpeaking = true;
    context.session.currentAiUtteranceId = utteranceId;
    context.session.turnState = 'speaking';
    sendEvent(ws, 'turn.state', {
      sessionId: context.session.sessionId,
      state: 'speaking',
      reason: 'tts_request'
    });
    try {
      await ttsBridge.streamAssistantText({
        session: context.sessionRow,
        text,
        utteranceId,
        sendEvent: (t, p) => sendEvent(ws, t, p),
        shouldAbort: () => !context.session.aiSpeaking,
        onCompleted: async ({ mouthCues }) => {
          await visemeBridge.emitTimeline({
            sendEvent: (t, p) => sendEvent(ws, t, p),
            utteranceId,
            text,
            preEnrichedMouthCues: mouthCues
          });
        }
      });
    } finally {
      context.session.aiSpeaking = false;
      context.session.currentAiUtteranceId = null;
      context.session.turnState = 'listening';
      sendEvent(ws, 'turn.state', {
        sessionId: context.session.sessionId,
        state: 'listening',
        reason: 'tts_end'
      });
    }
    return;
  }

  throw new VoiceStreamError('UNKNOWN_EVENT', `Bilinmeyen event: ${type}`, { recoverable: true });
}

async function cleanupContext(context) {
  try {
    clearVadTimer(context.session);
    if (context.webrtcTransport) {
      context.webrtcTransport.close();
      context.webrtcTransport = null;
    }
    if (context.provider) {
      await context.provider.close();
    }
  } catch (_) {}
  if (context.sessionRow?.id) {
    clearSessionSpeech(context.sessionRow.id);
  }
}

// ─── HTTP upgrade + WS server ─────────────────────────────────────────────────

function createVoiceGateway(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', async (request, socket, head) => {
    const parsedUrl = new URL(request.url, 'http://localhost');
    if (parsedUrl.pathname !== '/ws/voice') return; // başka gateway'ler ilgilensin

    if (!isVoiceStreamingEnabled()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const token = extractToken(request, parsedUrl);
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const decoded = verifyToken(token);

      const sessionId = parsedUrl.searchParams.get('sessionId');
      if (!sessionId) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const sessionRow = await getSessionById(sessionId);
      if (!sessionRow || sessionRow.userId !== decoded.id) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      await reconcileStaleCall(sessionId).catch(() => {});

      request.user = decoded;
      request.sessionRow = sessionRow;
    } catch (err) {
      warn('[VOICE] upgrade rejected', err.message);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    const context = {
      userRow: { id: request.user.id, email: request.user.email },
      sessionRow: request.sessionRow,
      session: null,
      provider: null,
      webrtcTransport: null,
      closeMeta: { serverInitiated: false, reason: null }
    };

    log('[VOICE] websocket connected', `userId=${context.userRow.id} sessionId=${context.sessionRow.id}`);
    touchSession(context.sessionRow.id).catch(() => {});

    sendEvent(ws, 'connection.ready', {
      featureEnabled: true,
      defaultLanguage: process.env.VOICE_DEFAULT_LANGUAGE || 'tr-TR',
      server: {
        sttProvider: getSttProviderName(),
        ttsProvider: 'elevenlabs',
        visemeProvider: visemeBridge.getProvider(),
        supportsWebRtc: isWebRtcEnabled(),
        webRtcRuntime: hasWebRtcRuntime()
      },
      session: {
        id: context.sessionRow.id,
        personaId: context.sessionRow.personaId,
        callLockedLanguage: context.sessionRow.callLockedLanguage,
        activeMode: context.sessionRow.activeMode
      },
      userId: context.userRow.id
    });

    ws.on('message', async (raw) => {
      let parsed = null;
      try {
        parsed = parseMessage(raw);
        voiceDebugLog(`event received | type=${parsed?.type || 'unknown'}`);
        await handleEvent(ws, context, parsed);
      } catch (error) {
        const retryable = isRecoverableError(error);
        sendEvent(ws, 'error', {
          code: error.code || 'UNEXPECTED_ERROR',
          message: error.message || 'Beklenmeyen hata',
          retryable,
          stage: error.stage || 'ws',
          requestId: parsed?.requestId || null
        });
        if (!retryable && ws.readyState === WebSocket.OPEN) {
          context.closeMeta.serverInitiated = true;
          context.closeMeta.reason = error.code || 'non_recoverable_error';
          ws.close(1011, 'non_recoverable_error');
        }
      }
    });

    ws.on('close', async (code, reasonBuf) => {
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
      await cleanupContext(context);
      log('[VOICE] websocket closed',
        `userId=${context.userRow.id} sessionId=${context.sessionRow.id} code=${code} reason=${reason || 'n/a'}`);
    });

    ws.on('error', async () => {
      await cleanupContext(context);
    });
  });

  return { wss };
}

module.exports = {
  createVoiceGateway,
  isVoiceStreamingEnabled,
  __testables: {
    handleEvent,
    initializeSession,
    setupProviderListeners,
    interruptAiIfSpeaking,
    ingestAudioChunk,
    finalizeUtterance,
    sendEvent
  }
};
