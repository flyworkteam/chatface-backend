/**
 * VoiceStreamError — voice/video gateway boyunca tek tip hata sınıfı.
 * Arşiv'den birebir taşındı.
 */
class VoiceStreamError extends Error {
  constructor(code, message, { recoverable = false, details = null } = {}) {
    super(message);
    this.name = 'VoiceStreamError';
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

function isRecoverableError(error) {
  if (!error) return false;
  if (typeof error.recoverable === 'boolean') return error.recoverable;
  return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'STT_TEMPORARY_FAILURE'].includes(error.code);
}

module.exports = {
  VoiceStreamError,
  isRecoverableError
};
