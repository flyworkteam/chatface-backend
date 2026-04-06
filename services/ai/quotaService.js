const DAILY_TTS_CHAR_LIMIT = parseInt(process.env.TTS_CHAR_LIMIT || '200000', 10);
const { STT_SESSION_MINUTE_LIMIT } = require('../../config/stt');

const STT_SESSION_LIMIT_MS = Math.max(STT_SESSION_MINUTE_LIMIT, 1) * 60 * 1000;

const quotaKey = (userId) => `tts_quota_${userId}_${new Date().toISOString().slice(0, 10)}`;

const inMemoryCounters = new Map();
const sttInMemoryCounters = new Map();

const sttQuotaKey = (sessionId) => `stt_quota_${sessionId}`;

const incrementQuota = (userId, chars) => {
  const key = quotaKey(userId);
  const current = inMemoryCounters.get(key) || 0;
  const updated = current + chars;
  inMemoryCounters.set(key, updated);
  return updated;
};

const canUseTTS = (userId) => {
  const key = quotaKey(userId);
  const used = inMemoryCounters.get(key) || 0;
  return used < DAILY_TTS_CHAR_LIMIT;
};

const incrementSessionSttUsage = (sessionId, deltaMs) => {
  const key = sttQuotaKey(sessionId);
  const current = sttInMemoryCounters.get(key) || 0;
  const updated = current + deltaMs;
  sttInMemoryCounters.set(key, updated);
  return updated;
};

const getSessionSttUsage = (sessionId) => {
  const key = sttQuotaKey(sessionId);
  return sttInMemoryCounters.get(key) || 0;
};

const hasSessionSttBudget = (sessionId, deltaMs = 0) => {
  const projected = getSessionSttUsage(sessionId) + deltaMs;
  return projected <= STT_SESSION_LIMIT_MS;
};

const resetSessionSttUsage = (sessionId) => {
  const key = sttQuotaKey(sessionId);
  sttInMemoryCounters.delete(key);
};

module.exports = {
  incrementQuota,
  canUseTTS,
  DAILY_TTS_CHAR_LIMIT,
  incrementSessionSttUsage,
  hasSessionSttBudget,
  resetSessionSttUsage,
  getSessionSttUsage,
  STT_SESSION_LIMIT_MS
};
