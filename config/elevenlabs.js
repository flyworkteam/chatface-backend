const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_22050_32';
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true
};

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
    voice_settings: { ...DEFAULT_VOICE_SETTINGS, ...settings },
    optimize_streaming_latency: 2,
    output_format: DEFAULT_OUTPUT_FORMAT,
    language,
    turbo: process.env.ELEVENLABS_TURBO === 'true'
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
