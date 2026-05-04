const {
  getTtsCacheContext,
  synthesizeSentence: synthesizeSentenceDirect,
  synthesizeSentenceViaN8n
} = require('../../config/elevenlabs');

// Phase 3: route TTS through n8n when USE_N8N_TTS=true
const USE_N8N_TTS = false;
const synthesizeSentence = USE_N8N_TTS ? synthesizeSentenceViaN8n : synthesizeSentenceDirect;
const {
  buildCacheKey,
  fetchCachedAudio,
  storeCachedAudio,
  updateCacheMetadata,
  primeTransientAudio
} = require('./ttsCacheService');
const { canUseTTS, incrementQuota } = require('./quotaService');
const { recordTtsCacheMiss } = require('./ttsWarmQueue');
const { log, warn } = require('./logger');
const { rememberAssistantSpeech } = require('./echoGuard');
const { uploadBuffer } = require('../../utils/bunny');
const { fetchMouthCues } = require('./mouthCueService');
const {
  appendLiveTtsStream,
  createLiveTtsStream,
  failLiveTtsStream,
  finishLiveTtsStream
} = require('./liveTtsStreamService');

const buildAudioUrl = (cacheKey) => `/api/ai/tts/cache/${cacheKey}`;
const LIVE_STREAM_ENABLED = process.env.TTS_LIVE_STREAM_ENABLED !== 'false';
const elapsedSec = (startedAt) =>
  startedAt ? Number(((Date.now() - startedAt) / 1000).toFixed(3)) : undefined;
const normalizeTtsText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
const hasSpeakableChars = (value = '') => /[\p{L}\p{N}]/u.test(value);
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
const isInvalidTtsText = (text = '') => {
  const normalized = normalizeTtsText(text);
  if (!normalized) return true;
  if (normalized.length < 2) return true;
  return !hasSpeakableChars(normalized);
};

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
  turnStartedAt,
  shouldAbort
}) => {
  if (isAborted(shouldAbort)) {
    return;
  }

  const audioUrl = cachePayload.cdnUrl || buildAudioUrl(cachePayload.cacheKey);

  sendEvent('tts_started', { sequence, playbackId });
  log('Voice turn cached TTS chunk ready', {
    playbackId,
    sequence,
    turnSec: elapsedSec(turnStartedAt),
    cacheKey: cachePayload.cacheKey
  });
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
  sessionId,
  personaId,
  language,
  text,
  variant,
  voiceConfig,
  sendEvent,
  userId,
  sequence,
  playbackId,
  previousText,
  mode = 'chat',
  liveStream = false,
  turnStartedAt,
  shouldAbort
}) => {
  if (!canUseTTS(userId)) {
    sendEvent('tts_suppressed', { reason: 'quota_exceeded', sequence, playbackId });
    warn('TTS quota exceeded for user', userId);
    return;
  }

  sendEvent('tts_started', { sequence, playbackId, voice: voiceConfig });
  const ttsStartedAt = Date.now();
  let liveStreamRef = null;
  if (liveStream && LIVE_STREAM_ENABLED) {
    liveStreamRef = createLiveTtsStream({
      sessionId,
      userId,
      sequence,
      playbackId
    });
    log('Voice turn first TTS stream URL emitted', {
      playbackId,
      sequence,
      stageSec: 0,
      turnSec: elapsedSec(turnStartedAt),
      audioUrl: liveStreamRef.url
    });
    emitTtsChunk({
      sendEvent,
      sequence,
      playbackId,
      chunkId: `${sequence}-live`,
      audioUrl: liveStreamRef.url,
      audioBase64: null,
      mouthCues: []
    });
  }

  let response;
  try {
    response = await synthesizeSentence({
      voiceId: voiceConfig.voiceId,
      text,
      language,
      settings: voiceConfig.settings,
      sampleRate: voiceConfig.sampleRate,
      previousText,
      mode,
      onTiming: (event, data) => {
        log(event, {
          playbackId,
          sequence,
          turnSec: elapsedSec(turnStartedAt),
          ...data
        });
      },
      onAudioChunk: liveStreamRef
        ? (chunk) => {
          if (!liveStreamRef.firstProviderChunkLogged) {
            liveStreamRef.firstProviderChunkLogged = true;
            log('Voice turn first ElevenLabs audio bytes received', {
              playbackId,
              sequence,
              stageSec: elapsedSec(ttsStartedAt),
              turnSec: elapsedSec(turnStartedAt),
              byteLength: chunk.length
            });
          }
          appendLiveTtsStream(liveStreamRef.id, chunk);
        }
        : undefined
    });
    if (liveStreamRef) {
      finishLiveTtsStream(liveStreamRef.id);
    }
  } catch (error) {
    if (liveStreamRef) {
      failLiveTtsStream(liveStreamRef.id, error);
    }
    throw error;
  }
  if (isAborted(shouldAbort)) {
    sendEvent('tts_suppressed', { reason: 'cancelled', sequence, playbackId });
    return;
  }

  const audioBase64 = response.audioBuffer.toString('base64');
  const mouthCues = response.mouthCues || [];
  const cacheContext = getTtsCacheContext({
    voiceId: voiceConfig.voiceId,
    language,
    mode
  });
  const cacheKey = buildCacheKey(personaId, language, text, variant, cacheContext);
  const audioUrl = buildAudioUrl(cacheKey);

  incrementQuota(userId, text.length);
  primeTransientAudio({
    cacheKey,
    audioBase64,
    mouthCues,
    cdnUrl: null
  });

  if (!liveStreamRef) {
    emitTtsChunk({
      sendEvent,
      sequence,
      playbackId,
      chunkId: `${sequence}-0`,
      audioUrl,
      audioBase64,
      mouthCues
    });
  }
  // For live-stream chunks we already emitted the stream URL with mouthCues:[].
  // Now that synthesis is complete we have the real mouthCues from ElevenLabs;
  // include them in tts_done so the Flutter client can apply lip-sync without
  // waiting for the slow background CDN viseme-enrichment pass.
  sendEvent('tts_done', { sequence, playbackId, mouthCues: liveStreamRef ? mouthCues : [] });
  log('Voice turn TTS provider completed', {
    playbackId,
    sequence,
    stageSec: elapsedSec(ttsStartedAt),
    turnSec: elapsedSec(turnStartedAt),
    liveStream: Boolean(liveStreamRef),
    byteLength: response.audioBuffer.length
  });

  queueBackgroundTask('Failed to persist live TTS audio', async () => {
    await storeCachedAudio({
      personaId,
      language,
      text,
      variant,
      audioBase64,
      mouthCues,
      cacheContext
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
  previousText,
  mode = 'chat',
  liveStream,
  turnStartedAt,
  shouldAbort
}) => {
  try {
    const normalizedText = normalizeTtsText(text);

    if (isInvalidTtsText(normalizedText)) {
      warn('TTS pipeline suppressed due to invalid sentence text', {
        sessionId,
        personaId,
        language,
        sequence,
        playbackId,
        textPreview: normalizedText.slice(0, 80)
      });
      sendEvent('tts_suppressed', { reason: 'invalid_text', sequence, playbackId });
      return;
    }

    rememberAssistantSpeech({ sessionId, text: normalizedText, playbackId });

    if (isAborted(shouldAbort)) {
      return;
    }

    const cacheContext = getTtsCacheContext({
      voiceId: voiceConfig.voiceId,
      language,
      mode
    });
    const cached = await fetchCachedAudio({
      personaId,
      language,
      text: normalizedText,
      variant,
      cacheContext
    });
    if (cached) {
      await streamCachedPayload({
        cachePayload: cached,
        sendEvent,
        sequence,
        playbackId,
        personaId,
        language,
        turnStartedAt,
        shouldAbort
      });
      return;
    }

    recordTtsCacheMiss({
      personaId,
      language,
      variant,
      text: normalizedText
    });

    await streamLivePayload({
      sessionId,
      personaId,
      language,
      text: normalizedText,
      variant,
      voiceConfig,
      sendEvent,
      userId,
      sequence,
      playbackId,
      previousText,
      mode,
      liveStream,
      turnStartedAt,
      shouldAbort
    });
  } catch (error) {
    if (error.liveStreamId) {
      failLiveTtsStream(error.liveStreamId, error);
    }
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
