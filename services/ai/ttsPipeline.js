const { synthesizeSentence } = require('../../config/elevenlabs');
const {
  buildCacheKey,
  fetchCachedAudio,
  storeCachedAudio,
  updateCacheMetadata,
  primeTransientAudio
} = require('./ttsCacheService');
const { canUseTTS, incrementQuota } = require('./quotaService');
const { log, warn } = require('./logger');
const { rememberAssistantSpeech } = require('./echoGuard');
const { uploadBuffer } = require('../../utils/bunny');
const { fetchMouthCues } = require('./mouthCueService');

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

const queueBackgroundTask = (label, task) => {
  Promise.resolve()
    .then(task)
    .catch((error) => warn(label, error.message));
};

const isAborted = (shouldAbort) => typeof shouldAbort === 'function' && shouldAbort() === true;

const emitTtsChunk = ({
  sendEvent,
  sequence,
  playbackId,
  chunkId,
  audioUrl,
  audioBase64,
  mouthCues
}) => {
  log('TTS chunk emitted', {
    playbackId,
    sequence,
    hasAudioUrl: Boolean(audioUrl),
    hasInlineAudio: Boolean(audioBase64),
    mouthCueCount: Array.isArray(mouthCues) ? mouthCues.length : 0
  });

  sendEvent('tts_chunk', {
    sequence,
    playbackId,
    chunkId,
    audioUrl,
    audio: audioBase64,
    mouthCues: mouthCues || [],
    offsetMs: 0
  });
};

const enrichMouthCuesInBackground = ({ cacheKey, audioUrl }) => {
  if (!audioUrl) {
    return;
  }

  queueBackgroundTask('Failed to enrich mouth cues', async () => {
    const mouthCues = await fetchMouthCues({ cacheKey, audioUrl });
    if (!mouthCues.length) {
      return;
    }

    await updateCacheMetadata({ cacheKey, mouthCues });
    primeTransientAudio({ cacheKey, audioBase64: null, mouthCues, cdnUrl: audioUrl });
  });
};

const streamCachedPayload = async ({
  cachePayload,
  sendEvent,
  sequence,
  playbackId,
  personaId,
  language,
  shouldAbort
}) => {
  if (isAborted(shouldAbort)) {
    return;
  }

  const audioUrl = cachePayload.cdnUrl || buildAudioUrl(cachePayload.cacheKey);

  sendEvent('tts_started', { sequence, playbackId });
  if (isAborted(shouldAbort)) {
    sendEvent('tts_suppressed', { reason: 'cancelled', sequence, playbackId });
    return;
  }
  emitTtsChunk({
    sendEvent,
    sequence,
    playbackId,
    chunkId: `${sequence}-cached`,
    audioUrl,
    audioBase64: cachePayload.audioBase64,
    mouthCues: cachePayload.mouthCues || []
  });
  sendEvent('tts_done', { sequence, playbackId });

  if (!cachePayload.cdnUrl && cachePayload.audioBase64) {
    queueBackgroundTask('Failed to upload cached TTS audio to BunnyCDN', async () => {
      const uploadedUrl = await uploadAudioToCdn({
        audioBuffer: Buffer.from(cachePayload.audioBase64, 'base64'),
        personaId,
        language,
        cacheKey: cachePayload.cacheKey
      });
      await updateCacheMetadata({ cacheKey: cachePayload.cacheKey, cdnUrl: uploadedUrl });
      if (!cachePayload.mouthCues?.length) {
        enrichMouthCuesInBackground({ cacheKey: cachePayload.cacheKey, audioUrl: uploadedUrl });
      }
    });
  } else if (!cachePayload.mouthCues?.length && cachePayload.cdnUrl) {
    enrichMouthCuesInBackground({ cacheKey: cachePayload.cacheKey, audioUrl: cachePayload.cdnUrl });
  }
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
  playbackId,
  shouldAbort
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
  if (isAborted(shouldAbort)) {
    sendEvent('tts_suppressed', { reason: 'cancelled', sequence, playbackId });
    return;
  }

  const audioBase64 = response.audioBuffer.toString('base64');
  const mouthCues = response.mouthCues || [];
  const cacheKey = buildCacheKey(personaId, language, text, variant);
  const audioUrl = buildAudioUrl(cacheKey);

  incrementQuota(userId, text.length);
  primeTransientAudio({
    cacheKey,
    audioBase64,
    mouthCues,
    cdnUrl: null
  });

  emitTtsChunk({
    sendEvent,
    sequence,
    playbackId,
    chunkId: `${sequence}-0`,
    audioUrl,
    audioBase64,
    mouthCues
  });
  sendEvent('tts_done', { sequence, playbackId });

  queueBackgroundTask('Failed to persist live TTS audio', async () => {
    await storeCachedAudio({
      personaId,
      language,
      text,
      variant,
      audioBase64,
      mouthCues
    });
  });

  queueBackgroundTask('Failed to upload live TTS audio to BunnyCDN', async () => {
    const uploadedUrl = await uploadAudioToCdn({
      audioBuffer: response.audioBuffer,
      personaId,
      language,
      cacheKey
    });
    await updateCacheMetadata({ cacheKey, cdnUrl: uploadedUrl });
    primeTransientAudio({
      cacheKey,
      audioBase64,
      mouthCues,
      cdnUrl: uploadedUrl
    });
    if (!mouthCues.length) {
      enrichMouthCuesInBackground({ cacheKey, audioUrl: uploadedUrl });
    }
  });
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
  playbackId,
  shouldAbort
}) => {
  try {
    rememberAssistantSpeech({ sessionId, text, playbackId });

    if (isAborted(shouldAbort)) {
      return;
    }

    const cached = await fetchCachedAudio({ personaId, language, text, variant });
    if (cached) {
      await streamCachedPayload({
        cachePayload: cached,
        sendEvent,
        sequence,
        playbackId,
        personaId,
        language,
        shouldAbort
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
      playbackId,
      shouldAbort
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
