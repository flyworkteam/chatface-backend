const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const gatewayPath = require.resolve('../services/voice/voiceGateway');
const providersPath = require.resolve('../services/voice/providers');
const webrtcTransportPath = require.resolve('../services/voice/webrtcTransport');
const aiPipelineBridgePath = require.resolve('../services/voice/bridges/aiPipelineBridge');
const ttsBridgePath = require.resolve('../services/voice/bridges/ttsBridge');
const visemeBridgePath = require.resolve('../services/voice/bridges/visemeBridge');
const loggerPath = require.resolve('../services/ai/logger');
const sessionServicePath = require.resolve('../services/ai/sessionService');
const jwtPath = require.resolve('../utils/jwt');
const echoGuardPath = require.resolve('../services/ai/echoGuard');

const createWsStub = () => {
  const sent = [];
  return {
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    messages: sent
  };
};

const loadGatewayWithMocks = ({ hasWebRtcRuntime = false } = {}) => {
  const touchedPaths = [
    gatewayPath,
    providersPath,
    webrtcTransportPath,
    aiPipelineBridgePath,
    ttsBridgePath,
    visemeBridgePath,
    loggerPath,
    sessionServicePath,
    jwtPath,
    echoGuardPath
  ];
  const originals = new Map(touchedPaths.map((path) => [path, require.cache[path]]));

  delete require.cache[gatewayPath];

  const provider = new EventEmitter();
  provider.startSession = async () => {};
  provider.pushAudioChunk = async () => {};
  provider.finalizeUtterance = async () => {};
  provider.close = async () => {};

  require.cache[providersPath] = {
    id: providersPath,
    filename: providersPath,
    loaded: true,
    exports: {
      createSttProvider: () => provider
    }
  };
  require.cache[webrtcTransportPath] = {
    id: webrtcTransportPath,
    filename: webrtcTransportPath,
    loaded: true,
    exports: {
      hasWebRtcRuntime: () => hasWebRtcRuntime,
      WebRtcTransport: class {
        async createAnswerFromOffer() {
          return 'answer-sdp';
        }
        async addIceCandidate() {}
        close() {}
      }
    }
  };
  require.cache[aiPipelineBridgePath] = {
    id: aiPipelineBridgePath,
    filename: aiPipelineBridgePath,
    loaded: true,
    exports: {
      processFinalTranscript: async ({ sendEvent, onAssistantText }) => {
        sendEvent('ai.response', { text: 'assistant says hi' });
        await onAssistantText('assistant says hi');
      }
    }
  };
  require.cache[ttsBridgePath] = {
    id: ttsBridgePath,
    filename: ttsBridgePath,
    loaded: true,
    exports: {
      streamAssistantText: async ({ utteranceId, sendEvent, onCompleted }) => {
        sendEvent('tts.start', { utteranceId });
        sendEvent('tts.chunk', { utteranceId, chunkSeq: 0, audioBase64: 'AQ==', isLast: false });
        sendEvent('tts.end', { utteranceId });
        await onCompleted({ mouthCues: [{ id: 1, time: 0.08 }] });
      }
    }
  };
  require.cache[visemeBridgePath] = {
    id: visemeBridgePath,
    filename: visemeBridgePath,
    loaded: true,
    exports: {
      getProvider: () => 'remote',
      isVisemeBlockingEnabled: () => true,
      emitTimeline: async ({ sendEvent, utteranceId }) => {
        sendEvent('viseme.timeline', {
          utteranceId,
          visemes: [{ id: 0, time: 0 }],
          isLast: true
        });
      }
    }
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      log: () => {},
      warn: () => {},
      debug: () => {}
    }
  };
  require.cache[sessionServicePath] = {
    id: sessionServicePath,
    filename: sessionServicePath,
    loaded: true,
    exports: {
      getSessionById: async () => null,
      reconcileStaleCall: async () => {},
      touchSession: async () => {}
    }
  };
  require.cache[jwtPath] = {
    id: jwtPath,
    filename: jwtPath,
    loaded: true,
    exports: { verifyToken: () => ({ id: 'user-1' }) }
  };
  require.cache[echoGuardPath] = {
    id: echoGuardPath,
    filename: echoGuardPath,
    loaded: true,
    exports: { clearSessionSpeech: () => {} }
  };

  const gateway = require(gatewayPath);
  const restore = () => {
    touchedPaths.forEach((path) => {
      const original = originals.get(path);
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    });
  };
  return {
    provider,
    handleEvent: gateway.__testables.handleEvent,
    restore
  };
};

test('voiceGateway happy path emits stt.final -> ai.response -> tts.end', async () => {
  process.env.VOICE_DEFAULT_LANGUAGE = 'tr-TR';
  process.env.STT_PROVIDER = 'openai-realtime';
  process.env.WEBRTC_ENABLED = 'true';

  const { provider, handleEvent, restore } = loadGatewayWithMocks({ hasWebRtcRuntime: false });
  try {
    const ws = createWsStub();
    const context = {
      userRow: { id: 'user-1', email: 'test@example.com' },
      sessionRow: {
        id: 'sess-1',
        userId: 'user-1',
        personaId: 'persona-1',
        language: 'tr-TR',
        callLockedLanguage: 'tr-TR',
        activeMode: 'voice_call'
      },
      session: null,
      provider: null,
      webrtcTransport: null
    };

    await handleEvent(ws, context, { type: 'session.start', payload: { transport: 'ws' } });
    provider.emit('final', {
      utteranceId: 'utt-1',
      language: 'tr-TR',
      transcript: 'merhaba',
      noSpeech: false
    });

    await new Promise((resolve) => setImmediate(resolve));

    const eventTypes = ws.messages.map((message) => message.type);
    assert.ok(eventTypes.includes('stt.final'));
    assert.ok(eventTypes.includes('ai.response'));
    assert.ok(eventTypes.includes('tts.end'));
    assert.ok(eventTypes.includes('viseme.timeline'));
  } finally {
    restore();
  }
});

test('voiceGateway barge-in emits interruption events on speech.start', async () => {
  process.env.VOICE_DEFAULT_LANGUAGE = 'tr-TR';
  process.env.STT_PROVIDER = 'openai-realtime';

  const { handleEvent, restore } = loadGatewayWithMocks({ hasWebRtcRuntime: false });
  try {
    const ws = createWsStub();
    const context = {
      userRow: { id: 'user-1', email: 'test@example.com' },
      sessionRow: {
        id: 'sess-2',
        userId: 'user-1',
        personaId: 'persona-1',
        language: 'tr-TR',
        callLockedLanguage: 'tr-TR',
        activeMode: 'voice_call'
      },
      session: null,
      provider: null,
      webrtcTransport: null
    };

    await handleEvent(ws, context, { type: 'session.start', payload: { transport: 'ws' } });
    context.session.aiSpeaking = true;
    context.session.currentAiUtteranceId = 'utt-speaking';

    await handleEvent(ws, context, {
      type: 'speech.start',
      payload: { utteranceId: 'utt-user' },
      requestId: 'req-1'
    });

    const eventTypes = ws.messages.map((message) => message.type);
    assert.ok(eventTypes.includes('tts.stop'));
    assert.ok(eventTypes.includes('ai.interrupted'));
    assert.ok(eventTypes.includes('ack'));
  } finally {
    restore();
  }
});

test('voiceGateway does not barge-in on raw audio.chunk frames', async () => {
  process.env.VOICE_DEFAULT_LANGUAGE = 'tr-TR';
  process.env.STT_PROVIDER = 'openai-realtime';

  const { handleEvent, restore } = loadGatewayWithMocks({ hasWebRtcRuntime: false });
  try {
    const ws = createWsStub();
    const context = {
      userRow: { id: 'user-1', email: 'test@example.com' },
      sessionRow: {
        id: 'sess-2b',
        userId: 'user-1',
        personaId: 'persona-1',
        language: 'tr-TR',
        callLockedLanguage: 'tr-TR',
        activeMode: 'voice_call'
      },
      session: null,
      provider: null,
      webrtcTransport: null
    };

    await handleEvent(ws, context, { type: 'session.start', payload: { transport: 'ws' } });
    context.session.aiSpeaking = true;
    context.session.currentAiUtteranceId = 'utt-speaking';

    await handleEvent(ws, context, {
      type: 'audio.chunk',
      payload: {
        utteranceId: 'utt-user',
        chunkSeq: 0,
        audioBase64: 'AQ==',
        sampleRate: 16000,
        channels: 1,
        format: 'pcm16'
      },
      requestId: 'req-audio'
    });

    const eventTypes = ws.messages.map((message) => message.type);
    assert.ok(!eventTypes.includes('tts.stop'));
    assert.ok(!eventTypes.includes('ai.interrupted'));
    assert.ok(eventTypes.includes('ack'));
  } finally {
    restore();
  }
});

test('voiceGateway returns WEBRTC_RUNTIME_MISSING when runtime is unavailable', async () => {
  process.env.VOICE_DEFAULT_LANGUAGE = 'tr-TR';
  process.env.STT_PROVIDER = 'openai-realtime';
  process.env.WEBRTC_ENABLED = 'true';

  const { handleEvent, restore } = loadGatewayWithMocks({ hasWebRtcRuntime: false });
  try {
    const ws = createWsStub();
    const context = {
      userRow: { id: 'user-1', email: 'test@example.com' },
      sessionRow: {
        id: 'sess-3',
        userId: 'user-1',
        personaId: 'persona-1',
        language: 'tr-TR',
        callLockedLanguage: 'tr-TR',
        activeMode: 'voice_call'
      },
      session: null,
      provider: null,
      webrtcTransport: null
    };

    await handleEvent(ws, context, { type: 'session.start', payload: { transport: 'ws' } });

    await assert.rejects(
      () => handleEvent(ws, context, { type: 'webrtc.offer', payload: { sdp: 'offer-sdp' } }),
      (error) => error && error.code === 'WEBRTC_RUNTIME_MISSING'
    );
  } finally {
    restore();
  }
});

test('voiceGateway emits webrtc.answer when runtime is available', async () => {
  process.env.VOICE_DEFAULT_LANGUAGE = 'tr-TR';
  process.env.STT_PROVIDER = 'openai-realtime';
  process.env.WEBRTC_ENABLED = 'true';

  const { handleEvent, restore } = loadGatewayWithMocks({ hasWebRtcRuntime: true });
  try {
    const ws = createWsStub();
    const context = {
      userRow: { id: 'user-1', email: 'test@example.com' },
      sessionRow: {
        id: 'sess-4',
        userId: 'user-1',
        personaId: 'persona-1',
        language: 'tr-TR',
        callLockedLanguage: 'tr-TR',
        activeMode: 'voice_call'
      },
      session: null,
      provider: null,
      webrtcTransport: null
    };

    await handleEvent(ws, context, { type: 'session.start', payload: { transport: 'ws' } });
    await handleEvent(ws, context, {
      type: 'webrtc.offer',
      payload: { sdp: 'offer-sdp' },
      requestId: 'req-offer'
    });

    const answerEvent = ws.messages.find((message) => message.type === 'webrtc.answer');
    assert.ok(answerEvent, 'webrtc.answer should be emitted');
    assert.equal(answerEvent.payload.sdp, 'answer-sdp');
  } finally {
    restore();
  }
});
