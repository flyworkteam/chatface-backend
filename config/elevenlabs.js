const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_22050_32';
const clamp = (value, min, max, fallback) => {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
};
const parseBoolean = (value, fallback) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};
const DEFAULT_VOICE_SETTINGS = {
  stability: clamp(process.env.ELEVENLABS_DEFAULT_STABILITY || '0.72', 0, 1, 0.72),
  similarity_boost: clamp(process.env.ELEVENLABS_DEFAULT_SIMILARITY_BOOST || '0.8', 0, 1, 0.8),
  style: clamp(process.env.ELEVENLABS_DEFAULT_STYLE || '0.08', 0, 1, 0.08),
  use_speaker_boost: parseBoolean(process.env.ELEVENLABS_DEFAULT_SPEAKER_BOOST, true)
};
const DEFAULT_STREAMING_LATENCY = Math.max(
  0,
  parseInt(process.env.ELEVENLABS_STREAMING_LATENCY || '0', 10)
);
const DEFAULT_TURBO = parseBoolean(process.env.ELEVENLABS_TURBO, false);

const buildHeaders = () => {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API key missing');
  }

  return {
    'xi-api-key': process.env.ELEVENLABS_API_KEY,
    'Content-Type': 'application/json'
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RATE_LIMIT_INTERVAL_MS = parseInt(process.env.ELEVENLABS_RATE_LIMIT_MS || '100', 10);
const MAX_RETRIES = parseInt(process.env.ELEVENLABS_MAX_RETRIES || '3', 10);
const BASE_BACKOFF_MS = parseInt(process.env.ELEVENLABS_BACKOFF_MS || '750', 10);

let nextSlot = 0;
let limiter = Promise.resolve();

const normalizeVoiceSettings = (settings = {}) => ({
  stability: clamp(settings.stability, 0, 1, DEFAULT_VOICE_SETTINGS.stability),
  similarity_boost: clamp(
    settings.similarity_boost,
    0,
    1,
    DEFAULT_VOICE_SETTINGS.similarity_boost
  ),
  style: clamp(settings.style, 0, 1, DEFAULT_VOICE_SETTINGS.style),
  use_speaker_boost: parseBoolean(
    settings.use_speaker_boost,
    DEFAULT_VOICE_SETTINGS.use_speaker_boost
  )
});

const scheduleRateLimited = (task) => {
  limiter = limiter.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    if (wait > 0) {
      await sleep(wait);
    }
    nextSlot = Date.now() + RATE_LIMIT_INTERVAL_MS;
    return task();
  });
  return limiter;
};

const synthesizeSentence = async ({
  voiceId,
  text,
  language,
  settings = {},
  sampleRate = DEFAULT_SAMPLE_RATE,
  enableTimestamps = true
}) => {
  if (!voiceId) {
    throw new Error('voiceId is required for TTS');
  }

  const payload = {
    text,
    model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    voice_settings: normalizeVoiceSettings(settings),
    optimize_streaming_latency: DEFAULT_STREAMING_LATENCY,
    output_format: DEFAULT_OUTPUT_FORMAT,
    language,
    turbo: DEFAULT_TURBO
  };

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  const attemptRequest = async () => {
    const response = await axios.post(url, payload, {
      headers: buildHeaders(),
      responseType: 'arraybuffer'
    });

    return {
      audioBuffer: Buffer.from(response.data),
      mimeType: 'audio/mpeg',
      alignmentKey: enableTimestamps
        ? crypto.createHash('sha1').update(text + language + voiceId).digest('hex')
        : null,
      mouthCues: []
    };
  };

  let attempt = 0;
  let lastError;

  while (attempt < MAX_RETRIES) {
    try {
      return await scheduleRateLimited(attemptRequest);
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (status === 429 && attempt < MAX_RETRIES - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        error.isRateLimit = true;
        await sleep(backoff);
        attempt += 1;
        continue;
      }
      if (status === 429) {
        const rateError = new Error('ElevenLabs rate limit exceeded');
        rateError.code = 'ELEVENLABS_RATE_LIMIT';
        throw rateError;
      }
      throw error;
    }
  }

  throw lastError;
};

module.exports = {
  synthesizeSentence
};
