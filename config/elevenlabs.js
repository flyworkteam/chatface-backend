const axios = require('axios');
const crypto = require('crypto');
const { PassThrough } = require('stream');
require('dotenv').config();
const { normalizeLanguageCode } = require('../services/ai/languageSupport');

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
const TTS_MODEL = 'eleven_multilingual_v2';
const CALL_TTS_MODEL = 'eleven_flash_v2_5';

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

const isCallMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const parseOptionalInteger = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveModelId = (mode = 'chat') =>
  isCallMode(mode) ? CALL_TTS_MODEL : TTS_MODEL;

const resolveStreamingLatency = (mode = 'chat') => {
  const callLatency = isCallMode(mode)
    ? parseOptionalInteger(process.env.ELEVENLABS_CALL_STREAMING_LATENCY)
    : null;
  return Math.max(0, callLatency ?? DEFAULT_STREAMING_LATENCY);
};

const resolveApplyTextNormalization = (mode = 'chat') => {
  const raw = isCallMode(mode)
    ? process.env.ELEVENLABS_CALL_APPLY_TEXT_NORMALIZATION
    : process.env.ELEVENLABS_APPLY_TEXT_NORMALIZATION;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['on', 'auto', 'off'].includes(normalized)) {
    return normalized;
  }
  return null;
};

const normalizeLocator = (locator) => {
  if (!locator || typeof locator !== 'object') {
    return null;
  }

  const pronunciationDictionaryId =
    locator.pronunciation_dictionary_id || locator.dictionary_id || locator.id;
  const versionId = locator.version_id || locator.versionId;

  if (!pronunciationDictionaryId || !versionId) {
    return null;
  }

  return {
    pronunciation_dictionary_id: String(pronunciationDictionaryId),
    version_id: String(versionId)
  };
};

const parsePronunciationConfig = () => {
  const raw = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARIES;
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
};

const locatorsForKey = (config, key) => {
  const value = config[key];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map(normalizeLocator).filter(Boolean);
};

const resolvePronunciationDictionaryLocators = ({ voiceId, language }) => {
  const config = parsePronunciationConfig();
  const normalizedLanguage = normalizeLanguageCode(language, language);
  const keys = [
    voiceId && normalizedLanguage ? `voice:${voiceId}:${normalizedLanguage}` : null,
    voiceId ? `voice:${voiceId}` : null,
    normalizedLanguage,
    'default'
  ].filter(Boolean);

  const seen = new Set();
  const locators = [];
  keys.forEach((key) => {
    locatorsForKey(config, key).forEach((locator) => {
      const dedupeKey = `${locator.pronunciation_dictionary_id}:${locator.version_id}`;
      if (seen.has(dedupeKey) || locators.length >= 3) {
        return;
      }
      seen.add(dedupeKey);
      locators.push(locator);
    });
  });

  return locators;
};

const getTtsCacheContext = ({ voiceId, language, mode = 'chat' }) => ({
  modelId: resolveModelId(mode),
  optimizeStreamingLatency: resolveStreamingLatency(mode),
  outputFormat: DEFAULT_OUTPUT_FORMAT,
  applyTextNormalization: resolveApplyTextNormalization(mode),
  pronunciationDictionaries: resolvePronunciationDictionaryLocators({
    voiceId,
    language
  })
});

const buildTtsPayload = ({
  voiceId,
  text,
  language,
  settings = {},
  previousText,
  nextText,
  mode = 'chat'
}) => {
  const normalizedLanguage = normalizeLanguageCode(language, language);
  const pronunciationLocators = resolvePronunciationDictionaryLocators({
    voiceId,
    language: normalizedLanguage
  });
  const modelId = resolveModelId(mode);
  const optimizeStreamingLatency = resolveStreamingLatency(mode);
  const applyTextNormalization = resolveApplyTextNormalization(mode);
  const payload = {
    text,
    model_id: modelId,
    voice_settings: normalizeVoiceSettings(settings),
    optimize_streaming_latency: optimizeStreamingLatency,
    output_format: DEFAULT_OUTPUT_FORMAT,
    language_code: normalizedLanguage,
    turbo: DEFAULT_TURBO
  };

  if (previousText) {
    payload.previous_text = previousText;
  }
  if (nextText) {
    payload.next_text = nextText;
  }
  if (pronunciationLocators.length) {
    payload.pronunciation_dictionary_locators = pronunciationLocators;
  }
  if (applyTextNormalization) {
    payload.apply_text_normalization = applyTextNormalization;
  }

  return payload;
};

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
  enableTimestamps = true,
  previousText,
  nextText,
  onAudioChunk,
  mode = 'chat',
  onTiming
}) => {
  if (!voiceId) {
    throw new Error('voiceId is required for TTS');
  }

  const payload = buildTtsPayload({
    voiceId,
    text,
    language,
    settings,
    previousText,
    nextText,
    mode
  });
  const modelId = payload.model_id;
  const optimizeStreamingLatency = payload.optimize_streaming_latency;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  const attemptRequest = async () => {
    const requestStartedAt = Date.now();
    let firstByteLogged = false;
    onTiming?.('tts_provider_request_started', {
      modelId,
      optimizeStreamingLatency,
      outputFormat: DEFAULT_OUTPUT_FORMAT,
      textLength: text.length,
      voiceId,
      language
    });
    const response = await axios.post(url, payload, {
      headers: buildHeaders(),
      responseType: onAudioChunk ? 'stream' : 'arraybuffer'
    });
    const responseHeadersSec = Number(((Date.now() - requestStartedAt) / 1000).toFixed(3));
    const responseHeaderData = {
      modelId,
      optimizeStreamingLatency,
      outputFormat: DEFAULT_OUTPUT_FORMAT,
      textLength: text.length,
      voiceId,
      language,
      responseHeadersSec,
      xRegion: response.headers?.['x-region'],
      currentConcurrentRequests: response.headers?.['current-concurrent-requests'],
      maximumConcurrentRequests: response.headers?.['maximum-concurrent-requests']
    };
    onTiming?.('tts_provider_response_headers', responseHeaderData);

    if (onAudioChunk && response.data?.pipe) {
      const stream = response.data.pipe(new PassThrough());
      const chunks = [];
      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          chunks.push(chunk);
          if (!firstByteLogged) {
            firstByteLogged = true;
            onTiming?.('tts_provider_first_byte', {
              ...responseHeaderData,
              firstByteSec: Number(((Date.now() - requestStartedAt) / 1000).toFixed(3)),
              byteLength: chunk.length
            });
          }
          onAudioChunk(Buffer.from(chunk));
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      return {
        audioBuffer: Buffer.concat(chunks),
        mimeType: 'audio/mpeg',
        alignmentKey: enableTimestamps
          ? crypto.createHash('sha1').update(text + language + voiceId).digest('hex')
          : null,
        mouthCues: []
      };
    }

    onTiming?.('tts_provider_first_byte', {
      ...responseHeaderData,
      firstByteSec: responseHeadersSec,
      byteLength: Buffer.byteLength(response.data)
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
      const queueEnteredAt = Date.now();
      const result = await scheduleRateLimited(attemptRequest);
      onTiming?.('tts_provider_complete', {
        modelId,
        optimizeStreamingLatency,
        outputFormat: DEFAULT_OUTPUT_FORMAT,
        textLength: text.length,
        voiceId,
        language,
        completeSec: Number(((Date.now() - queueEnteredAt) / 1000).toFixed(3))
      });
      return result;
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
  buildTtsPayload,
  getTtsCacheContext,
  resolveModelId,
  resolveStreamingLatency,
  resolvePronunciationDictionaryLocators,
  synthesizeSentence
};
