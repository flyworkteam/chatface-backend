const test = require('node:test');
const assert = require('node:assert/strict');

const providerPath = require.resolve('../services/voice/providers/OpenAiRealtimeSttProvider');
const sttServicePath = require.resolve('../services/ai/sttStreamService');

const loadProviderWithMockedSttService = (mockSttService) => {
  delete require.cache[providerPath];
  require.cache[sttServicePath] = {
    id: sttServicePath,
    filename: sttServicePath,
    loaded: true,
    exports: mockSttService
  };
  return require(providerPath);
};

test('OpenAiRealtimeSttProvider emits partial/final and forwards stop/terminate', async () => {
  const originalProvider = require.cache[providerPath];
  const originalSttService = require.cache[sttServicePath];
  let capturedStartContext = null;
  const calls = {
    pushAudioChunk: 0,
    stopStream: 0,
    terminateStream: 0
  };

  const mockSttService = {
    startStream: async (context) => {
      capturedStartContext = context;
    },
    pushAudioChunk: async () => {
      calls.pushAudioChunk += 1;
    },
    stopStream: async () => {
      calls.stopStream += 1;
    },
    terminateStream: async () => {
      calls.terminateStream += 1;
    }
  };

  try {
    const OpenAiRealtimeSttProvider = loadProviderWithMockedSttService(mockSttService);
    const provider = new OpenAiRealtimeSttProvider({ language: 'tr-TR', sampleRate: 16000 });

    const partialEvents = [];
    const finalEvents = [];
    provider.on('partial', (payload) => partialEvents.push(payload));
    provider.on('final', (payload) => finalEvents.push(payload));

    await provider.startSession({
      sessionRow: { id: 'sess-1' },
      userRow: { id: 'user-1' }
    });

    assert.ok(capturedStartContext, 'startStream context should be captured');
    capturedStartContext.sendEvent('stt_partial', { transcriptId: 'utt-1', text: 'merh' });
    await capturedStartContext.onTranscript({
      type: 'stt_transcript',
      transcriptId: 'utt-1',
      text: 'merhaba',
      metadata: { confidence: 0.9 }
    });

    assert.equal(partialEvents.length, 1);
    assert.equal(partialEvents[0].transcript, 'merh');
    assert.equal(finalEvents.length, 1);
    assert.equal(finalEvents[0].transcript, 'merhaba');

    await provider.pushAudioChunk({ utteranceId: 'utt-1', audioBytes: Buffer.from([1, 2, 3, 4]) });
    await provider.finalizeUtterance('utt-1');
    await provider.close();

    assert.equal(calls.pushAudioChunk, 1);
    assert.equal(calls.stopStream, 1);
    assert.equal(calls.terminateStream, 1);
  } finally {
    if (originalProvider) require.cache[providerPath] = originalProvider;
    else delete require.cache[providerPath];
    if (originalSttService) require.cache[sttServicePath] = originalSttService;
    else delete require.cache[sttServicePath];
  }
});
