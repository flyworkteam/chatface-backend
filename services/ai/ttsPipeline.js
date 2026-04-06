const { synthesizeSentence } = require('../../config/elevenlabs');
const { buildCacheKey, fetchCachedAudio, storeCachedAudio } = require('./ttsCacheService');
const { canUseTTS, incrementQuota } = require('./quotaService');
const { log, warn } = require('./logger');
const { rememberAssistantSpeech } = require('./echoGuard');
const { uploadBuffer } = require('../../utils/bunny');

const buildAudioUrl = (cacheKey) => `/api/ai/tts/cache/${cacheKey}`;
const sanitizePathSegment = (value, fallback = 'default') => {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const buildCdnAudioPath = ({ personaId, language, cacheKey }) => {
  const personaSegment = sanitizePathSegment(personaId, 'persona');
  const languageSegment = sanitizePathSegment(language, 'lang');
  return `tts/${personaSegment}/${languageSegment}/${cacheKey}.mp3`;
};

const uploadAudioToCdn = async ({ audioBuffer, personaId, language, cacheKey }) => {
  const destPath = buildCdnAudioPath({ personaId, language, cacheKey });
  return uploadBuffer(audioBuffer, destPath, 'audio/mpeg');
};

const streamCachedPayload = async ({
  cachePayload,
  sendEvent,
  sequence,
  playbackId,
  personaId,
  language
}) => {
  const audioBuffer = Buffer.from(cachePayload.audioBase64, 'base64');
  let audioUrl = buildAudioUrl(cachePayload.cacheKey);
  try {
    audioUrl = await uploadAudioToCdn({
      audioBuffer,
      personaId,
      language,
      cacheKey: cachePayload.cacheKey
    });
  } catch (error) {
    warn('Failed to upload cached TTS audio to BunnyCDN', error.message);
  }

  sendEvent('tts_started', { sequence, playbackId });
  sendEvent('tts_chunk', {
    sequence,
    playbackId,
    chunkId: `${sequence}-cached`,
    audioUrl,
    audio: cachePayload.audioBase64,
    mouthCues: cachePayload.mouthCues || [],
    offsetMs: 0
  });
  sendEvent('tts_done', { sequence, playbackId });
};

const streamLivePayload = async ({
  personaId,
  language,
  text,
  variant,
  voiceConfig,
  sendEvent,
  userId,
  sequence,
  playbackId
}) => {
  if (!canUseTTS(userId)) {
    sendEvent('tts_suppressed', { reason: 'quota_exceeded', sequence, playbackId });
    warn('TTS quota exceeded for user', userId);
    return;
  }

  sendEvent('tts_started', { sequence, playbackId, voice: voiceConfig });

  const response = await synthesizeSentence({
    voiceId: voiceConfig.voiceId,
    text,
    language,
    settings: voiceConfig.settings,
    sampleRate: voiceConfig.sampleRate
  });

  const audioBase64 = response.audioBuffer.toString('base64');
  const mouthCues = response.mouthCues || [];
  const cacheKey = buildCacheKey(personaId, language, text, variant);
  let audioUrl = buildAudioUrl(cacheKey);

  incrementQuota(userId, text.length);

  await storeCachedAudio({
    personaId,
    language,
    text,
    variant,
    audioBase64,
    mouthCues
  });

  try {
    audioUrl = await uploadAudioToCdn({
      audioBuffer: response.audioBuffer,
      personaId,
      language,
      cacheKey
    });
  } catch (error) {
    warn('Failed to upload live TTS audio to BunnyCDN', error.message);
  }

  sendEvent('tts_chunk', {
    sequence,
    playbackId,
    chunkId: `${sequence}-0`,
    audioUrl,
    audio: audioBase64,
    mouthCues,
    offsetMs: 0
  });

  sendEvent('tts_done', { sequence, playbackId });
};

const enqueueSentence = async ({
  sessionId,
  personaId,
  language,
  text,
  variant = 'default',
  voiceConfig,
  sendEvent,
  userId,
  sequence,
  playbackId
}) => {
  try {
    rememberAssistantSpeech({ sessionId, text, playbackId });

    const cached = await fetchCachedAudio({ personaId, language, text, variant });
    if (cached) {
      await streamCachedPayload({
        cachePayload: cached,
        sendEvent,
        sequence,
        playbackId,
        personaId,
        language
      });
      return;
    }

    await streamLivePayload({
      personaId,
      language,
      text,
      variant,
      voiceConfig,
      sendEvent,
      userId,
      sequence,
      playbackId
    });
  } catch (error) {
    if (error.code === 'ELEVENLABS_RATE_LIMIT' || error.isRateLimit) {
      warn('TTS pipeline suppressed due to provider rate limit');
      sendEvent('tts_suppressed', { reason: 'provider_rate_limited', sequence, playbackId });
      return;
    }
    warn('TTS pipeline failed', error.message);
    sendEvent('error', { type: 'tts_error', message: error.message, sequence, playbackId });
  }
};

module.exports = {
  enqueueSentence
};
