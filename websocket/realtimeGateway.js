const WebSocket = require('ws');
const { verifyToken } = require('../utils/jwt');
const { getSessionById, touchSession, updateSessionLanguage } = require('../services/ai/sessionService');
const {
  handleUserMessage,
  handleSttTranscript
} = require('../services/ai/chatOrchestrator');
const { handleTtsRequest } = require('../services/ai/ttsRequestService');
const sttStreamService = require('../services/ai/sttStreamService');
const { clearSessionSpeech } = require('../services/ai/echoGuard');
const { debug, log, warn } = require('../services/ai/logger');
const {
  SUPPORTED_SESSION_LANGUAGES,
  normalizeLanguageCode
} = require('../services/ai/languageSupport');

const HEARTBEAT_INTERVAL = 20000;
const PREVIEW_LIMIT = 90;
const STT_TRANSPORTS = new Set(['json', 'binary']);
const TTS_PAYLOADS = new Set(['url', 'inline', 'both']);

const previewText = (text) => {
  if (!text) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > PREVIEW_LIMIT ? `${normalized.slice(0, PREVIEW_LIMIT)}…` : normalized;
};

const initializeRealtimeGateway = (server) => {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    const parsedUrl = new URL(request.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    if (pathname !== '/realtime') {
      // Diğer gateway'ler (voice/video) kendi listener'larında işleyecek;
      // socket'i destroy etmiyoruz — Arşiv migration planı Phase 8.
      return;
    }

    try {
      if (!query?.token || !query?.sessionId) {
        socket.destroy();
        return;
      }
      const decoded = verifyToken(query.token);
      const session = await getSessionById(query.sessionId);

      if (!session || session.userId !== decoded.id) {
        socket.destroy();
        return;
      }

      request.user = decoded;
      request.session = session;
      request.capabilities = {
        sttTransport: resolveSttTransport(query?.sttTransport),
        ttsPayload: resolveTtsPayload(query?.ttsPayload)
      };

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (error) {
      warn('WebSocket upgrade rejected', error.message);
      socket.destroy();
    }
  });

  wss.on('connection', (ws, request) => {
    const { session, user, capabilities } = request;
    ws.context = { session, user, capabilities };
    ws.isAlive = true;

    touchSession(session.id).catch((error) => warn('Failed to touch session', error.message));
    log('Realtime connection established', session.id);

    ws.send(
      JSON.stringify({
        type: 'session_ready',
        sessionId: session.id,
        personaId: session.personaId,
        capabilities
      })
    );

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw, isBinary) => {
      try {
        const payload = parseIncomingPayload(raw, isBinary);
        const shouldLogInboundEvent = !['stt_audio_chunk', 'ping', 'pong'].includes(payload.type);
        const logger = shouldLogInboundEvent ? log : debug;
        logger('Realtime inbound event', {
          sessionId: session.id,
          userId: user.id,
          type: payload.type,
          transcriptId: payload.transcriptId || payload.clientMessageId,
          isFinal: payload.isFinal,
          hasText: Boolean(payload.text),
          textPreview: previewText(payload.text),
          approxBytes: Buffer.isBuffer(raw)
            ? raw.length
            : typeof raw === 'string'
              ? Buffer.byteLength(raw)
              : raw?.length
        });
        await routeIncomingEvent(ws, payload);
      } catch (error) {
        warn('Failed to process message', error.message);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });

    ws.on('close', () => {
      log('Realtime connection closed', session.id);
      clearSessionSpeech(session.id);
      sttStreamService
        .terminateStream(session.id)
        .catch((err) => warn('Failed to cleanup STT stream', err.message));
    });
  });

  setInterval(() => {
    wss.clients.forEach((client) => {
      if (!client.isAlive) {
        client.terminate();
        return;
      }
      client.isAlive = false;
      client.ping(() => {});
      client.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    });
  }, HEARTBEAT_INTERVAL);
};

const routeIncomingEvent = async (ws, payload) => {
  if (!ws.context) {
    return;
  }
  const sendEvent = (type, data = {}) => {
    const payload = { ...data };

    if (type === 'error' && Object.prototype.hasOwnProperty.call(payload, 'type')) {
      payload.errorType = payload.type;
      delete payload.type;
    }

    const outgoing = shapeOutgoingEvent(type, payload, ws.context?.capabilities);
    ws.send(JSON.stringify({ type, ...outgoing }));
  };

  switch (payload.type) {
    case 'user_message':
      await handleUserMessage(
        { session: ws.context.session, user: ws.context.user },
        payload,
        sendEvent
      );
      break;
    case 'request_tts':
      await handleTtsRequest(
        { session: ws.context.session, user: ws.context.user },
        payload,
        sendEvent
      );
      break;
    case 'stt_transcript':
      await handleSttTranscript(
        { session: ws.context.session, user: ws.context.user },
        payload,
        sendEvent
      );
      break;
    case 'stt_stream_start':
      await sttStreamService.startStream(
        {
          session: ws.context.session,
          user: ws.context.user,
          sendEvent,
          onTranscript: (transcriptPayload) =>
            handleSttTranscript(
              { session: ws.context.session, user: ws.context.user },
              transcriptPayload,
              sendEvent
            )
        },
        payload
      );
      break;
    case 'stt_audio_chunk':
      await sttStreamService.pushAudioChunk(
        { session: ws.context.session, user: ws.context.user, sendEvent },
        payload
      );
      break;
    case 'stt_stream_stop':
      await sttStreamService.stopStream(
        { session: ws.context.session, user: ws.context.user, sendEvent },
        payload
      );
      break;
    case 'update_language':
      await handleLanguageUpdate(ws, payload, sendEvent);
      break;
    case 'ping':
      debug('Realtime JSON ping received', {
        sessionId: ws.context.session.id,
        userId: ws.context.user.id,
        ts: payload?.ts
      });
      ws.isAlive = true;
      sendEvent('pong', { ts: payload?.ts || Date.now() });
      break;
    case 'pong':
      ws.isAlive = true;
      break;
    default:
      sendEvent('error', { message: `Unknown event: ${payload.type}` });
  }
};

const handleLanguageUpdate = async (ws, payload, sendEvent) => {
  const { session, user } = ws.context;
  const languageCode = normalizeLanguageCode(payload.language);

  if (!languageCode || !SUPPORTED_SESSION_LANGUAGES.has(languageCode)) {
    sendEvent('error', {
      type: 'invalid_language',
      message: `Unsupported language: ${languageCode}. Supported: ${[...SUPPORTED_SESSION_LANGUAGES].join(', ')}`
    });
    return;
  }

  try {
    await updateSessionLanguage(session.id, languageCode);
    ws.context.session = { ...session, language: languageCode };

    log('Session language updated', {
      sessionId: session.id,
      userId: user.id,
      from: session.language,
      to: languageCode
    });

    try {
      await sttStreamService.terminateStream(session.id);
    } catch (sttErr) {
      warn('Failed to terminate STT on language change', sttErr.message);
    }

    sendEvent('language_updated', {
      language: languageCode,
      sessionId: session.id
    });
  } catch (error) {
    warn('Language update failed', error.message);
    sendEvent('error', { type: 'language_update_failed', message: error.message });
  }
};

const parseIncomingPayload = (raw, isBinary) => {
  if (isBinary) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    return {
      type: 'stt_audio_chunk',
      audio: buffer,
      encoding: 'pcm16'
    };
  }

  if (typeof raw === 'string') {
    return JSON.parse(raw);
  }

  if (Buffer.isBuffer(raw)) {
    return JSON.parse(raw.toString());
  }

  return JSON.parse(raw?.toString?.() || '{}');
};

const resolveSttTransport = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return STT_TRANSPORTS.has(normalized) ? normalized : 'json';
};

const resolveTtsPayload = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return TTS_PAYLOADS.has(normalized) ? normalized : 'both';
};

const shapeOutgoingEvent = (type, payload, capabilities = {}) => {
  if (type !== 'tts_chunk') {
    return payload;
  }

  const shaped = { ...payload };
  const ttsPayload = resolveTtsPayload(capabilities.ttsPayload);
  if (ttsPayload === 'url' && shaped.audioUrl) {
    delete shaped.audio;
  } else if (ttsPayload === 'inline' && shaped.audio) {
    delete shaped.audioUrl;
  }

  return shaped;
};

module.exports = {
  initializeRealtimeGateway
};
