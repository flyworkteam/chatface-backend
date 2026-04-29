const test = require('node:test');
const assert = require('node:assert/strict');

const bridgePath = require.resolve('../services/voice/bridges/aiPipelineBridge');
const chatOrchestratorPath = require.resolve('../services/ai/chatOrchestrator');
const fillerAudioServicePath = require.resolve('../services/ai/fillerAudioService');

const clearBridgeCache = () => {
  delete require.cache[bridgePath];
  delete require.cache[chatOrchestratorPath];
  delete require.cache[fillerAudioServicePath];
};

test('aiPipelineBridge emits cant_understand filler when moderation error arrives', async () => {
  clearBridgeCache();

  require.cache[chatOrchestratorPath] = {
    id: chatOrchestratorPath,
    filename: chatOrchestratorPath,
    loaded: true,
    exports: {
      handleSttTranscript: async (_ctx, _payload, sendEvent) => {
        sendEvent('error', {
          code: 'moderation',
          message: 'Message blocked',
        });
      },
    },
  };

  require.cache[fillerAudioServicePath] = {
    id: fillerAudioServicePath,
    filename: fillerAudioServicePath,
    loaded: true,
    exports: {
      getFiller: async ({ scenario }) => {
        if (scenario !== 'cant_understand') {
          return null;
        }
        return {
          language: 'tr',
          cdnUrl: 'https://cdn.example.com/fillers/cant-understand.mp3',
          mouthCues: [],
          durationMs: 900,
          text: 'Pardon, tekrar eder misin?',
        };
      },
    },
  };

  const { processFinalTranscript } = require('../services/voice/bridges/aiPipelineBridge');

  const events = [];
  await processFinalTranscript({
    session: {
      id: 's-1',
      personaId: 'p-1',
      language: 'tr',
      callLockedLanguage: 'tr',
      activeMode: 'video_call',
    },
    user: { id: 9 },
    transcript: 'bana bir hikaye anlatır mısın',
    utteranceId: 'u-1',
    language: 'tr',
    sendEvent: (type, payload) => {
      events.push({ type, payload });
    },
    onAssistantText: async () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));

  const errorEvent = events.find((event) => event.type === 'error');
  assert.ok(errorEvent);
  assert.equal(String(errorEvent.payload.code).toLowerCase(), 'moderation');
  assert.match(
    String(errorEvent.payload.message || ''),
    /yanıt veremiyorum|farklı bir şekilde sor/i
  );

  const fillerEvent = events.find((event) => event.type === 'filler.audio');
  assert.ok(fillerEvent);
  assert.equal(fillerEvent.payload.scenario, 'cant_understand');
  assert.equal(
    fillerEvent.payload.audioUrl,
    'https://cdn.example.com/fillers/cant-understand.mp3'
  );

  clearBridgeCache();
});
