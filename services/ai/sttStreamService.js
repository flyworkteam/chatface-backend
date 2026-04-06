const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const {
  OPENAI_API_KEY,
  STT_REALTIME_MODEL,
  STT_TRANSCRIBE_MODEL,
  STT_SAMPLE_RATE,
  STT_MAX_LAG_MS,
  STT_PARTIAL_THROTTLE_MS,
  STT_STREAM_ENABLED,
  STT_ALLOW_LOCAL_FALLBACK
} = require('../../config/stt');
const { log, warn } = require('./logger');
const {
  hasSessionSttBudget,
  incrementSessionSttUsage,
  getSessionSttUsage,
  STT_SESSION_LIMIT_MS
} = require('./quotaService');

const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(STT_REALTIME_MODEL)}`;
const MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_ENCODING = 'pcm16';
const PROTOCOLS = ['realtime'];
const HEADERS = {
  'OpenAI-Beta': 'realtime=v1'
};

const streams = new Map();

const ensureStreamingEnabled = () => {
  if (!STT_STREAM_ENABLED) {
    throw new Error('Streaming STT has been disabled by configuration.');
  }
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
};

const summarizeQuota = (sessionId) => ({
  usedMs: getSessionSttUsage(sessionId),
  limitMs: STT_SESSION_LIMIT_MS
});

const sendSttError = (controller, message, extra = {}) => {
  if (!controller?.sendEvent) {
    return;
  }
  controller.sendEvent('error', {
    type: 'stt_unavailable',
    message,
    allowFallback: STT_ALLOW_LOCAL_FALLBACK,
    fallback: STT_ALLOW_LOCAL_FALLBACK ? 'local_stt' : undefined,
    ...extra
  });
};

const estimateDurationMs = (byteLength, sampleRate = STT_SAMPLE_RATE, encoding = DEFAULT_ENCODING) => {
  if (!byteLength) {
    return 0;
  }
  const bytesPerSample = encoding === 'pcm16' ? 2 : 2;
  const samples = byteLength / bytesPerSample;
  return Math.round((samples / sampleRate) * 1000);
};

const normalizeAudioPayload = (payload = {}) => {
  if (!payload) {
    return null;
  }
  if (Buffer.isBuffer(payload)) {
    return { base64: payload.toString('base64'), byteLength: payload.length };
  }
  if (typeof payload === 'string') {
    const sanitized = payload.split('base64,').pop();
    try {
      const buffer = Buffer.from(sanitized, 'base64');
      return { base64: sanitized, byteLength: buffer.length };
    } catch (err) {
      return null;
    }
  }
  if (payload?.audio) {
    return normalizeAudioPayload(payload.audio);
  }
  if (ArrayBuffer.isView(payload)) {
    return normalizeAudioPayload(
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    );
  }
  return null;
};

const computeConfidence = (logprobs) => {
  if (!Array.isArray(logprobs) || logprobs.length === 0) {
    return undefined;
  }
  const avg = logprobs.reduce((sum, entry) => sum + (entry?.logprob || 0), 0) / logprobs.length;
  const probability = Math.exp(avg);
  const clamped = Math.min(Math.max(probability, 0), 1);
  return Number(clamped.toFixed(4));
};

const previewSnippet = (text = '') => {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
};

const isNonRetriableRealtimeError = (error = {}) => {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  return (
    message.includes('invalid value') ||
    message.includes('supported values are') ||
    message.includes('transcription session update event') ||
    message.includes('quota') ||
    code === 'insufficient_quota'
  );
};

const resolveSessionUpdateEventType = () => {
  const model = String(STT_REALTIME_MODEL || '').toLowerCase();
  if (model.startsWith('gpt-realtime')) {
    return 'session.update';
  }
  return 'transcription_session.update';
};

const configureTranscriptionSession = (controller) => {
  const { socket, encoding, languageHint } = controller;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const payload = {
    type: resolveSessionUpdateEventType(),
    session: {
      input_audio_format: encoding,
      input_audio_transcription: {
        model: STT_TRANSCRIBE_MODEL,
        language: languageHint
      },
      turn_detection: {
        type: 'server_vad',
        silence_duration_ms: STT_MAX_LAG_MS,
        prefix_padding_ms: 200,
        threshold: 0.55
      }
    }
  };
  socket.send(JSON.stringify(payload));
};

const getOrCreateTranscriptState = (controller, itemId) => {
  if (!controller.transcripts.has(itemId)) {
    controller.transcripts.set(itemId, {
      id: uuidv4(),
      text: '',
      startedAt: Date.now(),
      lastPartialAt: 0
    });
  }
  return controller.transcripts.get(itemId);
};

const handleTranscriptionDelta = (controller, event) => {
  const transcript = getOrCreateTranscriptState(controller, event.item_id);
  transcript.startedAt = transcript.startedAt || Date.now();
  if (event.delta) {
    transcript.text += event.delta;
  }
  const now = Date.now();
  if (now - transcript.lastPartialAt < STT_PARTIAL_THROTTLE_MS) {
    return;
  }
  transcript.lastPartialAt = now;
  controller.sendEvent('stt_partial', {
    transcriptId: transcript.id,
    text: transcript.text
  });
};

const handleTranscriptionComplete = async (controller, event) => {
  const transcript = getOrCreateTranscriptState(controller, event.item_id);
  transcript.text = event.transcript?.trim() || transcript.text;
  const latencyMs = Date.now() - (transcript.startedAt || controller.startedAt || Date.now());
  const metadata = {
    source: 'whisper',
    latencyMs,
    whisper: {
      itemId: event.item_id,
      usage: event.usage,
      confidence: computeConfidence(event.logprobs),
      logprobs: event.logprobs
    }
  };
  log('Realtime STT transcript completed', {
    sessionId: controller.sessionId,
    transcriptId: transcript.id,
    latencyMs,
    preview: previewSnippet(transcript.text)
  });

  try {
    await controller.onTranscript({
      type: 'stt_transcript',
      transcriptId: transcript.id,
      text: transcript.text,
      isFinal: true,
      metadata
    });
  } catch (err) {
    warn('Failed to forward Whisper transcript', err?.message);
  } finally {
    controller.transcripts.delete(event.item_id);
  }
};

const handleRealtimeEvent = (controller, event) => {
  switch (event.type) {
    case 'conversation.item.input_audio_transcription.delta':
      handleTranscriptionDelta(controller, event);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      handleTranscriptionComplete(controller, event);
      break;
    case 'error':
      sendSttError(controller, event?.error?.message || 'OpenAI realtime error', {
        detail: event
      });
      if (isNonRetriableRealtimeError(event?.error)) {
        destroyController(controller, 'non_retriable_error').catch((err) =>
          warn('Failed to destroy STT stream on non-retriable error', err?.message)
        );
      }
      break;
    default:
      break;
  }
};

const registerSocketListeners = (controller) => {
  const { socket } = controller;
  socket.on('message', (payload, isBinary) => {
    try {
      if (isBinary) {
        return;
      }
      const event = JSON.parse(payload.toString());
      handleRealtimeEvent(controller, event);
    } catch (err) {
      warn('Failed to parse realtime payload', err?.message);
    }
  });

  socket.on('close', (code) => {
    if (controller.destroyed) {
      return;
    }
    warn('Realtime STT socket closed', {
      sessionId: controller.sessionId,
      code
    });
    if (controller.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      sendSttError(controller, 'Streaming STT became unavailable after multiple retries.', summarizeQuota(controller.sessionId));
      destroyController(controller, 'reconnect_failed');
      return;
    }
    controller.reconnectAttempts += 1;
    const backoff = 250 * Math.pow(2, controller.reconnectAttempts);
    const timer = setTimeout(() => {
      connectSocket(controller).catch((err) => warn('STT reconnect failed', err?.message));
    }, backoff);
    timer.unref?.();
  });

  socket.on('error', (err) => {
    warn('Realtime socket error', err?.message || err);
  });
};

const connectSocket = (controller) =>
  new Promise((resolve, reject) => {
    try {
      const socket = new WebSocket(REALTIME_URL, PROTOCOLS, {
        headers: {
          ...HEADERS,
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      });
      controller.socket = socket;
      const handleOpen = () => {
        socket.removeListener('error', handleError);
        controller.reconnectAttempts = 0;
        log('Realtime STT stream connected', {
          sessionId: controller.sessionId,
          userId: controller.userId
        });
        configureTranscriptionSession(controller);
        resolve();
      };
      const handleError = (err) => {
        socket.removeListener('open', handleOpen);
        reject(err);
      };
      socket.once('open', handleOpen);
      socket.once('error', handleError);
      registerSocketListeners(controller);
    } catch (err) {
      reject(err);
    }
  });

const destroyController = async (controller, reason = 'shutdown') => {
  controller.destroyed = true;
  if (controller.idleTimer) {
    clearTimeout(controller.idleTimer);
  }
  if (controller.socket && controller.socket.readyState === WebSocket.OPEN) {
    try {
      controller.socket.close(1000, reason);
    } catch (err) {
      warn('Failed to close STT socket', err?.message);
    }
  }
  streams.delete(controller.sessionId);
  log('STT stream destroyed', {
    sessionId: controller.sessionId,
    reason
  });
};

const resetIdleTimer = (controller) => {
  if (controller.idleTimer) {
    clearTimeout(controller.idleTimer);
  }
  controller.idleTimer = setTimeout(() => {
    sendSttError(controller, 'Streaming audio idle timeout.');
    destroyController(controller, 'idle_timeout');
  }, STT_MAX_LAG_MS);
  controller.idleTimer.unref?.();
};

const appendChunk = (controller, payload) => {
  if (!controller.socket || controller.socket.readyState !== WebSocket.OPEN) {
    sendSttError(controller, 'Streaming STT is warming up, chunk dropped.');
    return false;
  }
  const normalized = normalizeAudioPayload(payload.audio ?? payload);
  if (!normalized) {
    sendSttError(controller, 'Audio chunk missing or invalid.');
    return false;
  }
  const durationMs = estimateDurationMs(normalized.byteLength, controller.sampleRate, controller.encoding);

  incrementSessionSttUsage(controller.sessionId, durationMs);
  controller.bufferedMs += durationMs;
  controller.socket.send(
    JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: normalized.base64
    })
  );
  resetIdleTimer(controller);

  const now = Date.now();
  const wallClockElapsed = now - controller.startedAt;
  const aheadMs = controller.bufferedMs - wallClockElapsed;
  if (aheadMs > STT_MAX_LAG_MS) {
    sendSttError(controller, 'Audio chunks are arriving too quickly. Dropping latest chunk.', {
      aheadMs
    });
    return false;
  }

  if (payload?.vad === 'stop' || payload?.isFinal) {
    commitBuffer(controller);
  }
  return true;
};

const commitBuffer = (controller) => {
  if (!controller.socket || controller.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  controller.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
};

const startStream = async ({ session, user, sendEvent, onTranscript }, options = {}) => {
  const mode = session?.mode;
  if (mode === 'chat') {
    sendEvent('error', { message: 'Streaming STT is not available in chat sessions.' });
    return;
  }

  if (typeof onTranscript !== 'function') {
    throw new Error('Streaming STT requires an onTranscript callback.');
  }

  try {
    ensureStreamingEnabled();
  } catch (err) {
    sendSttError({ sendEvent }, err.message);
    throw err;
  }

  const sampleRate = parseInt(options.sampleRate || STT_SAMPLE_RATE, 10);
  const encoding = (options.encoding || DEFAULT_ENCODING).toLowerCase();
  if (encoding !== 'pcm16') {
    sendEvent('error', { message: 'Only 16-bit PCM audio is supported for streaming STT.' });
    return;
  }

  const existing = streams.get(session.id);
  if (existing) {
    await destroyController(existing, 'restart');
  }

  const controller = {
    sessionId: session.id,
    userId: user.id,
    sampleRate,
    encoding,
    sendEvent,
    onTranscript,
    transcripts: new Map(),
    bufferedMs: 0,
    reconnectAttempts: 0,
    destroyed: false,
    idleTimer: null,
    startedAt: Date.now(),
    languageHint: session.language || options.language,
    socket: null
  };

  streams.set(session.id, controller);

  try {
    await connectSocket(controller);
    sendEvent('stt_stream_ready', {
      sampleRate,
      encoding,
      transcriptId: options.transcriptId
    });
  } catch (err) {
    streams.delete(session.id);
    sendSttError(controller, 'Unable to start streaming STT.');
    throw err;
  }
};

const pushAudioChunk = async ({ session, sendEvent }, payload) => {
  const controller = streams.get(session.id);
  if (!controller) {
    if (STT_ALLOW_LOCAL_FALLBACK) {
      return;
    }
    sendEvent?.('error', { message: 'Streaming STT has not been started for this session.' });
    return;
  }
  appendChunk(controller, payload);
};

const stopStream = async ({ session, sendEvent }, payload = {}) => {
  const controller = streams.get(session.id);
  if (!controller) {
    if (STT_ALLOW_LOCAL_FALLBACK) {
      return;
    }
    sendEvent?.('error', { message: 'No active streaming STT session to stop.' });
    return;
  }
  commitBuffer(controller);
  if (payload?.close === true) {
    await destroyController(controller, 'client_close');
  }
};

const terminateStream = async (sessionId) => {
  const controller = streams.get(sessionId);
  if (!controller) {
    return;
  }
  await destroyController(controller, 'connection_closed');
};

module.exports = {
  startStream,
  pushAudioChunk,
  stopStream,
  terminateStream
};
