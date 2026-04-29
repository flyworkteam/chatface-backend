const { randomUUID } = require('crypto');

function createSessionState({ userId, conversationId, language = 'tr-TR', sampleRate = 16000, sessionId }) {
  return {
    sessionId: sessionId || randomUUID(),
    userId,
    conversationId,
    language,
    sampleRate,
    startedAt: Date.now(),
    transport: 'ws',
    turnState: 'listening', // listening | thinking | speaking
    aiSpeaking: false,
    currentAiUtteranceId: null,
    activeUtteranceId: null,
    lastChunkAt: null,
    processedChunks: new Set(),
    vad: {
      enabled: true,
      silenceMs: 900,
      timer: null
    }
  };
}

function chunkId(utteranceId, chunkSeq) {
  return `${utteranceId}:${chunkSeq}`;
}

function markChunkProcessed(state, utteranceId, chunkSeq) {
  state.processedChunks.add(chunkId(utteranceId, chunkSeq));
}

function isChunkProcessed(state, utteranceId, chunkSeq) {
  return state.processedChunks.has(chunkId(utteranceId, chunkSeq));
}

function clearVadTimer(state) {
  if (state?.vad?.timer) {
    clearTimeout(state.vad.timer);
    state.vad.timer = null;
  }
}

module.exports = {
  createSessionState,
  markChunkProcessed,
  isChunkProcessed,
  clearVadTimer
};
