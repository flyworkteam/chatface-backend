const SttProvider = require('./SttProvider');
const { VoiceStreamError } = require('../errors');

/**
 * Test/development provider. textHint geldiğinde onu, gelmediğinde
 * "ses alındı" dummy transcript döner. Production'da kullanılmaz.
 */
class MockSttProvider extends SttProvider {
  constructor(config = {}) {
    super(config);
    this.utteranceBuffers = new Map();
  }

  async startSession() {
    return true;
  }

  async pushAudioChunk(payload) {
    const { utteranceId, textHint, language = 'tr-TR' } = payload;
    if (!utteranceId) {
      throw new VoiceStreamError('BAD_UTTERANCE_ID', 'utteranceId gerekli', { recoverable: false });
    }

    const previous = this.utteranceBuffers.get(utteranceId) || [];
    if (textHint && typeof textHint === 'string' && textHint.trim()) {
      previous.push(textHint.trim());
    } else {
      previous.push('...');
    }
    this.utteranceBuffers.set(utteranceId, previous);

    this.emit('partial', {
      utteranceId,
      language,
      transcript: previous.join(' ').slice(0, 250)
    });
  }

  async finalizeUtterance(utteranceId) {
    const chunks = this.utteranceBuffers.get(utteranceId) || [];
    const transcript = chunks.join(' ').replace(/\s+/g, ' ').trim() || 'ses alındı';
    this.utteranceBuffers.delete(utteranceId);
    this.emit('final', {
      utteranceId,
      language: this.config.language || 'tr-TR',
      transcript
    });
  }
}

module.exports = MockSttProvider;
