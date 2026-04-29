const MockSttProvider = require('./MockSttProvider');
const { VoiceStreamError } = require('../errors');

let DeepgramSttProvider = null;
try {
  DeepgramSttProvider = require('./DeepgramSttProvider');
} catch (_) {
  DeepgramSttProvider = null;
}

let OpenAiWhisperSttProvider = null;
try {
  OpenAiWhisperSttProvider = require('./OpenAiWhisperSttProvider');
} catch (_) {
  OpenAiWhisperSttProvider = null;
}

let OpenAiRealtimeSttProvider = null;
try {
  OpenAiRealtimeSttProvider = require('./OpenAiRealtimeSttProvider');
} catch (_) {
  OpenAiRealtimeSttProvider = null;
}

/**
 * Provider seçim factory'si. STT_PROVIDER env'i ile yönetilir.
 * Default: openai-realtime (mevcut sttStreamService akışı).
 */
function createSttProvider(config = {}) {
  const providerName = (config.provider || 'openai-realtime').toLowerCase();

  if (providerName === 'mock') {
    return new MockSttProvider(config);
  }
  if (providerName === 'deepgram') {
    if (!DeepgramSttProvider) {
      throw new VoiceStreamError(
        'STT_PROVIDER_NOT_AVAILABLE',
        'Deepgram provider dosyası bulunamadı',
        { recoverable: false }
      );
    }
    return new DeepgramSttProvider(config);
  }
  if (providerName === 'openai-whisper' || providerName === 'whisper') {
    if (!OpenAiWhisperSttProvider) {
      throw new VoiceStreamError(
        'STT_PROVIDER_NOT_AVAILABLE',
        'OpenAI Whisper provider dosyası bulunamadı',
        { recoverable: false }
      );
    }
    return new OpenAiWhisperSttProvider(config);
  }
  if (providerName === 'openai-realtime' || providerName === 'openai' || providerName === 'realtime') {
    if (!OpenAiRealtimeSttProvider) {
      throw new VoiceStreamError(
        'STT_PROVIDER_NOT_AVAILABLE',
        'OpenAI Realtime provider dosyası bulunamadı',
        { recoverable: false }
      );
    }
    return new OpenAiRealtimeSttProvider(config);
  }
  throw new VoiceStreamError(
    'STT_PROVIDER_NOT_SUPPORTED',
    `Desteklenmeyen STT provider: ${providerName}`,
    { recoverable: false }
  );
}

module.exports = {
  createSttProvider
};
