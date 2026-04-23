/**
 * STT configuration — rewrite v2
 *
 * Split responsibilities clarified:
 *   - STT_MAX_LAG_MS is the audio back-pressure budget (appendChunk drops
 *     chunks arriving too far ahead of wall-clock time).
 *   - STT_SILENCE_DURATION_MS is the VAD end-of-turn silence threshold.
 *   These were conflated in v1 and the VAD was effectively set to 1200 ms,
 *   which made the mic chop off soft endings on slower speakers.
 *
 * Per-language VAD overrides live in LANGUAGE_VAD_OVERRIDES — applied at
 * startStream time based on the session's call_locked_language.
 * See REWRITE_ARCHITECTURE.md §6.
 */

const DEFAULTS = {
  realtimeModel: 'gpt-realtime-mini',
  transcribeModel: 'gpt-4o-mini-transcribe',
  sampleRate: 16000,
  chunkMs: 200,
  maxLagMs: 1200,
  idleTimeoutMs: 6000,
  partialThrottleMs: 150,
  sessionMinuteLimit: 15,
  vadThreshold: 0.42,
  vadPrefixPaddingMs: 450,
  vadSilenceDurationMs: 700,
  keepaliveSilenceMs: 5000
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STT_REALTIME_MODEL = process.env.STT_REALTIME_MODEL || DEFAULTS.realtimeModel;
const STT_TRANSCRIBE_MODEL = process.env.STT_TRANSCRIBE_MODEL || DEFAULTS.transcribeModel;
const STT_SAMPLE_RATE = parseInt(process.env.STT_SAMPLE_RATE || DEFAULTS.sampleRate, 10);
const STT_CHUNK_MS = parseInt(process.env.STT_CHUNK_MS || DEFAULTS.chunkMs, 10);
const STT_MAX_LAG_MS = parseInt(process.env.STT_MAX_LAG_MS || DEFAULTS.maxLagMs, 10);
const STT_IDLE_TIMEOUT_MS = parseInt(
  process.env.STT_IDLE_TIMEOUT_MS || DEFAULTS.idleTimeoutMs,
  10
);
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

const STT_VAD_THRESHOLD = parseFloat(
  process.env.STT_VAD_THRESHOLD || DEFAULTS.vadThreshold
);
const STT_VAD_PREFIX_PADDING_MS = parseInt(
  process.env.STT_VAD_PREFIX_PADDING_MS || DEFAULTS.vadPrefixPaddingMs,
  10
);
const STT_VAD_SILENCE_DURATION_MS = parseInt(
  process.env.STT_VAD_SILENCE_DURATION_MS || DEFAULTS.vadSilenceDurationMs,
  10
);
const STT_KEEPALIVE_SILENCE_MS = parseInt(
  process.env.STT_KEEPALIVE_SILENCE_MS || DEFAULTS.keepaliveSilenceMs,
  10
);

// Per-language VAD overrides — CJK / TR need softer thresholds + longer pauses.
const LANGUAGE_VAD_OVERRIDES = {
  tr: { threshold: 0.38, prefixPaddingMs: 500, silenceDurationMs: 800 },
  ja: { threshold: 0.40, prefixPaddingMs: 500, silenceDurationMs: 900 },
  ko: { threshold: 0.40, prefixPaddingMs: 500, silenceDurationMs: 900 },
  zh: { threshold: 0.40, prefixPaddingMs: 500, silenceDurationMs: 900 },
  hi: { threshold: 0.42, prefixPaddingMs: 450, silenceDurationMs: 800 }
};

const resolveVadConfig = (languageCode) => {
  const override =
    languageCode && LANGUAGE_VAD_OVERRIDES[String(languageCode).toLowerCase()];
  return {
    threshold: override?.threshold ?? STT_VAD_THRESHOLD,
    prefixPaddingMs: override?.prefixPaddingMs ?? STT_VAD_PREFIX_PADDING_MS,
    silenceDurationMs: override?.silenceDurationMs ?? STT_VAD_SILENCE_DURATION_MS
  };
};

module.exports = {
  OPENAI_API_KEY,
  STT_REALTIME_MODEL,
  STT_TRANSCRIBE_MODEL,
  STT_SAMPLE_RATE,
  STT_CHUNK_MS,
  STT_MAX_LAG_MS,
  STT_IDLE_TIMEOUT_MS,
  STT_PARTIAL_THROTTLE_MS,
  STT_STREAM_ENABLED,
  STT_ALLOW_LOCAL_FALLBACK,
  STT_SESSION_MINUTE_LIMIT,
  STT_VAD_THRESHOLD,
  STT_VAD_PREFIX_PADDING_MS,
  STT_VAD_SILENCE_DURATION_MS,
  STT_KEEPALIVE_SILENCE_MS,
  LANGUAGE_VAD_OVERRIDES,
  resolveVadConfig
};
