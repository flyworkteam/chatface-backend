const DEFAULTS = {
  realtimeModel: 'gpt-realtime-mini',
  transcribeModel: 'gpt-4o-mini-transcribe',
  sampleRate: 16000,
  chunkMs: 200,
  maxLagMs: 1200,
  partialThrottleMs: 150,
  sessionMinuteLimit: 15
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STT_REALTIME_MODEL = process.env.STT_REALTIME_MODEL || DEFAULTS.realtimeModel;
const STT_TRANSCRIBE_MODEL = process.env.STT_TRANSCRIBE_MODEL || DEFAULTS.transcribeModel;
const STT_SAMPLE_RATE = parseInt(process.env.STT_SAMPLE_RATE || DEFAULTS.sampleRate, 10);
const STT_CHUNK_MS = parseInt(process.env.STT_CHUNK_MS || DEFAULTS.chunkMs, 10);
const STT_MAX_LAG_MS = parseInt(process.env.STT_MAX_LAG_MS || DEFAULTS.maxLagMs, 10);
const STT_PARTIAL_THROTTLE_MS = parseInt(
  process.env.STT_PARTIAL_THROTTLE_MS || DEFAULTS.partialThrottleMs,
  10
);
const STT_STREAM_ENABLED = process.env.STT_STREAM_ENABLED !== 'false';
const STT_ALLOW_LOCAL_FALLBACK = process.env.STT_ALLOW_LOCAL_FALLBACK === 'true';
const STT_SESSION_MINUTE_LIMIT = parseInt(
  process.env.STT_SESSION_MINUTE_LIMIT || DEFAULTS.sessionMinuteLimit,
  10
);

module.exports = {
  OPENAI_API_KEY,
  STT_REALTIME_MODEL,
  STT_TRANSCRIBE_MODEL,
  STT_SAMPLE_RATE,
  STT_CHUNK_MS,
  STT_MAX_LAG_MS,
  STT_PARTIAL_THROTTLE_MS,
  STT_STREAM_ENABLED,
  STT_ALLOW_LOCAL_FALLBACK,
  STT_SESSION_MINUTE_LIMIT
};
