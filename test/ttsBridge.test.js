const test = require('node:test');
const assert = require('node:assert/strict');

const bridgePath = require.resolve('../services/voice/bridges/ttsBridge');
const ttsPipelinePath = require.resolve('../services/ai/ttsPipeline');
const messageAssemblerPath = require.resolve('../services/ai/messageAssembler');
const voicePath = require.resolve('../services/ai/voice');
const memoryRepoPath = require.resolve('../services/ai/memoryRepository');
const loggerPath = require.resolve('../services/ai/logger');

const loadBridgeWithMocks = () => {
  delete require.cache[bridgePath];
  require.cache[ttsPipelinePath] = {
    id: ttsPipelinePath,
    filename: ttsPipelinePath,
    loaded: true,
    exports: {
      enqueueSentence: async ({ sendEvent }) => {
        sendEvent('tts_started', { voice: { voiceId: 'voice-1' } });
        sendEvent('tts_chunk', { audioUrl: 'https://cdn.example/clip.mp3', audio: 'AQID' });
        sendEvent('tts_done', { mouthCues: [{ id: 1, time: 0.12 }] });
      }
    }
  };
  require.cache[messageAssemblerPath] = {
    id: messageAssemblerPath,
    filename: messageAssemblerPath,
    loaded: true,
    exports: {
      splitIntoSpeechChunks: () => ['Merhaba!']
    }
  };
  require.cache[voicePath] = {
    id: voicePath,
    filename: voicePath,
    loaded: true,
    exports: {
      buildVoiceConfig: () => ({ voiceId: 'voice-1', settings: {} }),
      DEFAULT_LANGUAGE: 'tr-TR'
    }
  };
  require.cache[memoryRepoPath] = {
    id: memoryRepoPath,
    filename: memoryRepoPath,
    loaded: true,
    exports: {
      getPersonaVoice: async () => ({ elevenlabs_voice_id: 'voice-1' })
    }
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn: () => {} }
  };
  return require(bridgePath);
};

test('ttsBridge maps pipeline events to tts.start/chunk/end', async () => {
  const touched = [
    bridgePath,
    ttsPipelinePath,
    messageAssemblerPath,
    voicePath,
    memoryRepoPath,
    loggerPath
  ];
  const originals = new Map(touched.map((path) => [path, require.cache[path]]));
  try {
    const ttsBridge = loadBridgeWithMocks();
    const events = [];
    let completedPayload = null;

    await ttsBridge.streamAssistantText({
      session: {
        id: 'sess-1',
        userId: 'user-1',
        personaId: 'persona-1',
        language: 'tr-TR',
        activeMode: 'voice_call'
      },
      text: 'Merhaba!',
      utteranceId: 'utt-1',
      sendEvent: (type, payload) => events.push({ type, payload }),
      onCompleted: async (payload) => {
        completedPayload = payload;
      }
    });

    const types = events.map((entry) => entry.type);
    assert.ok(types.includes('tts.start'));
    assert.ok(types.includes('tts.end'));

    const streamingChunk = events.find((entry) => entry.type === 'tts.chunk' && entry.payload.isLast === false);
    assert.ok(streamingChunk, 'streaming tts.chunk should exist');
    assert.equal(streamingChunk.payload.audioUrl, 'https://cdn.example/clip.mp3');
    assert.equal(streamingChunk.payload.audioBase64, 'AQID');

    const terminalChunk = events.find((entry) => entry.type === 'tts.chunk' && entry.payload.isLast === true);
    assert.ok(terminalChunk, 'terminal tts.chunk marker should exist');

    assert.ok(completedPayload, 'onCompleted should be called');
    assert.deepEqual(completedPayload.mouthCues, [{ id: 1, time: 0.12 }]);
  } finally {
    touched.forEach((path) => {
      const original = originals.get(path);
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    });
  }
});
