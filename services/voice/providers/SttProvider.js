const EventEmitter = require('events');

/**
 * Tüm STT provider'ları bu base class'tan türer. Voice gateway sadece bu
 * arayüze konuşur — `partial` ve `final` event'lerini dinler.
 */
class SttProvider extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
  }

  // eslint-disable-next-line no-unused-vars
  async startSession(_sessionContext) {
    throw new Error('startSession must be implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async pushAudioChunk(_payload) {
    throw new Error('pushAudioChunk must be implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async finalizeUtterance(_utteranceId) {
    throw new Error('finalizeUtterance must be implemented');
  }

  async close() {}
}

module.exports = SttProvider;
