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
const { WebRtcTransport, hasWebRtcRuntime } = require('./webrtcTransport');
const ttsBridge = require('./bridges/ttsBridge');
const aiPipelineBridge = require('./bridges/aiPipelineBridge');
const visemeBridge = require('./bridges/visemeBridge');
const { resamplePcm16 } = require('./audioUtils');

function isVideoCallEnabled() {
  return String(process.env.VIDEO_CALL_ENABLED || 'false').toLowerCase() === 'true';
}

function isVideoDebugEnabled() {
  return String(process.env.VIDEO_DEBUG_LOGS || process.env.VOICE_DEBUG_LOGS || 'false').toLowerCase() === 'true';
}

function videoDebugLog(message) {
  if (isVideoDebugEnabled()) {
    debug('[VIDEO]', message);
  }
}

function isWebRtcEnabled() {
  return String(process.env.WEBRTC_ENABLED || 'false').toLowerCase() === 'true';
}

function getSttProviderName() {
  return String(process.env.STT_PROVIDER || 'openai-realtime').toLowerCase();
}

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

function normalizeStartSession(context) {
  context.session = {
    sessionId: context.sessionRow.id,
    userId: context.userRow.id,
    personaId: context.sessionRow.personaId,
    language: context.sessionRow.callLockedLanguage || context.sessionRow.language || process.env.VOICE_DEFAULT_LANGUAGE || 'tr-TR',
    activeMode: 'video_call',
    aiSpeaking: false,
    currentAiUtteranceId: null,
    turnState: 'listening',
    startedAt: Date.now(),
    sampleRate: 16000,
    audio: {
      codec: 'pcm16le',
      sampleRate: 16000,
      channels: 1,
      frameMs: 20
    },
    webrtc: { audioFrameSeq: 0 },
    activeUtteranceId: null
  };
}

async function initializeSession(context, payload = {}) {
  normalizeStartSession(context);
  const requestedAudio = payload.audio || {};
  const requestedRate = Number(requestedAudio.sampleRate || 16000);
  const requestedFrameMs = Number(requestedAudio.frameMs || 20);
  const session = context.session;
  session.sampleRate = Number.isFinite(requestedRate) ? requestedRate : 16000;
  session.audio = {
    codec: 'pcm16le',
    sampleRate: session.sampleRate,
    channels: 1,
    frameMs: Number.isFinite(requestedFrameMs) ? requestedFrameMs : 20
  };
  session.transport = (payload.transport || 'webrtc').toLowerCase();
  session.personaId = context.sessionRow.personaId;
  session.callLockedLanguage = context.sessionRow.callLockedLanguage || null;
  session.activeMode = context.sessionRow.activeMode || 'video_call';

  const provider = createSttProvider({
    provider: getSttProviderName(),
    language: session.language,
    sampleRate: session.sampleRate
  });

  await provider.startSession({
    sessionId: session.sessionId,
    userId: session.userId,
    conversationId: session.sessionId,
    language: session.language,
    sessionRow: context.sessionRow,
    userRow: context.userRow
  });

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
                Promise.resolve().then(() =>
                  visemeBridge.emitTimeline({
                    sendEvent: (type, payload) => sendEvent(ws, type, payload),
                    utteranceId,
                    text: assistantText,
                    voiceId: null,
                    preEnrichedMouthCues: mouthCues
                  })
                ).catch((err) => warn('videoGateway viseme background failed', err.message));
              }
            }
          });
        } catch (err) {
          warn('videoGateway TTS pipeline failed', err.message);
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

function interruptAiIfSpeaking(ws, context, reason = 'user_interrupt') {
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

async function handleTtsRequest(ws, context, payload = {}, requestId = null) {
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
  }, requestId);

  try {
    await ttsBridge.streamAssistantText({
      session: {
        ...context.sessionRow,
        activeMode: 'video_call'
      },
      text,
      utteranceId,
      sendEvent: (type, data) => sendEvent(ws, type, data),
      shouldAbort: () => !context.session.aiSpeaking,
      onCompleted: async ({ mouthCues }) => {
        if (visemeBridge.isVisemeBlockingEnabled()) {
          await visemeBridge.emitTimeline({
            sendEvent: (type, data) => sendEvent(ws, type, data),
            utteranceId,
            text,
            preEnrichedMouthCues: mouthCues
          });
          return;
        }

        Promise.resolve().then(() =>
          visemeBridge.emitTimeline({
            sendEvent: (type, data) => sendEvent(ws, type, data),
            utteranceId,
            text,
            preEnrichedMouthCues: mouthCues
          })
        ).catch((err) => warn('videoGateway viseme background failed', err.message));
      }
    });
  } catch (err) {
    warn('videoGateway TTS pipeline failed', err.message);
    sendEvent(ws, 'error', {
      code: 'TTS_PIPELINE_ERROR',
      message: err.message,
      retryable: false,
      stage: 'tts'
    }, requestId);
  } finally {
    context.session.aiSpeaking = false;
    context.session.currentAiUtteranceId = null;
    context.session.turnState = 'listening';
    sendEvent(ws, 'turn.state', {
      sessionId: context.session.sessionId,
      state: 'listening',
      reason: 'tts_end'
    }, requestId);
  }
}

function ensureWebRtcTransport(ws, context) {
  if (context.webrtcTransport) {
    return context.webrtcTransport;
  }

  context.webrtcTransport = new WebRtcTransport({
    onTrack: (track) => {
      sendEvent(ws, 'webrtc.track', {
        sessionId: context.session.sessionId,
        ...track
      });
    },
    onPcmFrame: async (frame) => {
      if (!context.session || !context.provider) return;
      const utteranceId = context.session.activeUtteranceId;
      if (!utteranceId) {
        return;
      }
      context.session.webrtc.audioFrameSeq += 1;
      const inputSampleRate = Number(frame.sampleRate || context.session.sampleRate || 16000);
      let normalizedSampleRate = inputSampleRate;
      let normalizedAudioBytes = frame.audioBytes;
      if (inputSampleRate !== 16000) {
        normalizedAudioBytes = resamplePcm16(frame.audioBytes, inputSampleRate, 16000);
        normalizedSampleRate = 16000;
      }

      try {
        await context.provider.pushAudioChunk({
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
        });
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

  return context.webrtcTransport;
}

async function handleEvent(ws, context, message) {
  const { type, payload = {}, requestId = null } = message;

  if (!type) {
    throw new VoiceStreamError('MISSING_EVENT_TYPE', 'type alanı gerekli', { recoverable: true });
  }

  if (type === 'ping') {
    sendEvent(ws, 'pong', { ok: true }, requestId);
    return;
  }

  if (type === 'session.start' || type === 'video.session.start') {
    await initializeSession(context, payload);
    setupProviderListeners(ws, context);
    sendEvent(ws, 'session.ready', {
      sessionId: context.session.sessionId,
      userId: context.session.userId,
      personaId: context.session.personaId,
      language: context.session.language,
      activeMode: context.session.activeMode,
      supportsWebRtc: isWebRtcEnabled(),
      webRtcRuntime: hasWebRtcRuntime(),
      visemeProvider: visemeBridge.getProvider(),
      sttProvider: getSttProviderName()
    }, requestId);
    return;
  }

  if (!context.session || !context.provider) {
    throw new VoiceStreamError('SESSION_NOT_STARTED', 'Önce session.start gönderilmeli', { recoverable: true });
  }

  if (type === 'webrtc.offer' || type === 'video.webrtc.offer') {
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

    ensureWebRtcTransport(ws, context);

    const sdp = payload?.sdp;
    if (!sdp) {
      throw new VoiceStreamError('BAD_WEBRTC_OFFER', 'sdp gerekli', { recoverable: true });
    }

    const answerSdp = await context.webrtcTransport.createAnswerFromOffer(sdp);
    sendEvent(ws, 'webrtc.answer', { sdp: answerSdp }, requestId);
    return;
  }

  if (type === 'webrtc.ice' || type === 'video.webrtc.ice') {
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
    ensureWebRtcTransport(ws, context);
    await context.webrtcTransport.addIceCandidate(payload?.candidate || null);
    sendEvent(ws, 'ack', { ackType: 'webrtc.ice' }, requestId);
    return;
  }

  if (type === 'camera.toggle' || type === 'video.camera.toggle') {
    const enabled = payload?.enabled !== false;
    sendEvent(ws, 'camera.state', {
      sessionId: context.session.sessionId,
      enabled
    }, requestId);
    return;
  }

  if (type === 'tts.request' || type === 'video.tts.request') {
    await handleTtsRequest(ws, context, payload, requestId);
    return;
  }

  // Voice and video mobile clients may send speech lifecycle markers.
  // Video gateway currently does not use these markers server-side, but
  // acknowledging them keeps protocol compatibility and avoids noisy errors.
  if (type === 'speech.start' || type === 'speech.stop' || type === 'utterance.end') {
    if (type === 'speech.start') {
      const utteranceId = payload.utteranceId || randomUUID();
      context.session.activeUtteranceId = utteranceId;
      interruptAiIfSpeaking(ws, context, 'speech.start');
      sendEvent(ws, 'ack', { ackType: 'speech.start', utteranceId }, requestId);
      return;
    }
    const utteranceId = payload.utteranceId || context.session.activeUtteranceId;
    if (utteranceId) {
      try {
        await context.provider.finalizeUtterance(utteranceId);
      } catch (_) {}
    }
    if (type !== 'speech.start') {
      context.session.activeUtteranceId = null;
    }
    sendEvent(ws, 'ack', { ackType: type }, requestId);
    return;
  }

  if (type === 'call.end' || type === 'video.call.end') {
    interruptAiIfSpeaking(ws, context, 'call_end');
    sendEvent(ws, 'call.ended', {
      sessionId: context.session.sessionId,
      reason: payload?.reason || 'client_end'
    }, requestId);
    ws.close(1000, 'call_end');
    return;
  }

  throw new VoiceStreamError('UNKNOWN_EVENT', `Bilinmeyen event: ${type}`, { recoverable: true });
}

async function cleanupContext(context) {
  try {
    if (context.webrtcTransport) {
      context.webrtcTransport.close();
      context.webrtcTransport = null;
    }
  } catch (_) {}
  try {
    if (context.provider) {
      await context.provider.close();
      context.provider = null;
    }
  } catch (_) {}
  if (context.sessionRow?.id) {
    clearSessionSpeech(context.sessionRow.id);
  }
}

function createVideoGateway(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', async (request, socket, head) => {
    const parsedUrl = new URL(request.url, 'http://localhost');
    if (parsedUrl.pathname !== '/ws/video') return;

    if (!isVideoCallEnabled()) {
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
      warn('[VIDEO] upgrade rejected', err.message);
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
      webrtcTransport: null
    };

    log('[VIDEO] websocket connected', `userId=${context.userRow.id} sessionId=${context.sessionRow.id}`);
    touchSession(context.sessionRow.id).catch(() => {});

    sendEvent(ws, 'connection.ready', {
      featureEnabled: true,
      server: {
        supportsWebRtc: isWebRtcEnabled(),
        webRtcRuntime: hasWebRtcRuntime(),
        visemeProvider: visemeBridge.getProvider()
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
        videoDebugLog(`event received | type=${parsed?.type || 'unknown'}`);
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
          ws.close(1011, 'non_recoverable_error');
        }
      }
    });

    ws.on('close', async (code, reasonBuf) => {
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
      await cleanupContext(context);
      log('[VIDEO] websocket closed',
        `userId=${context.userRow.id} sessionId=${context.sessionRow.id} code=${code} reason=${reason || 'n/a'}`);
    });

    ws.on('error', async () => {
      await cleanupContext(context);
    });
  });

  return { wss };
}

module.exports = {
  createVideoGateway,
  isVideoCallEnabled
};
