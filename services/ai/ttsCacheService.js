const crypto = require('crypto');
const { pool } = require('../../config/database');
const TRANSIENT_TTL_MS = parseInt(process.env.TTS_TRANSIENT_TTL_MS || '900000', 10);
const CACHE_VERSION = process.env.TTS_CACHE_VERSION || '20260408-quality-v1';
const transientAudio = new Map();

const buildCacheKey = (personaId, language, text, variant) => {
  return crypto.createHash('sha1').update(`${CACHE_VERSION}:${personaId}:${language}:${variant}:${text}`).digest('hex');
};

const fetchCachedAudio = async ({ personaId, language, text, variant }) => {
  const key = buildCacheKey(personaId, language, text, variant);
  const [rows] = await pool.execute(
    `SELECT audio_base64, mouth_cues_json, hit_count, cdn_url
     FROM tts_cache
     WHERE cache_key = ?`,
    [key]
  );

  if (!rows.length) {
    return null;
  }

  const record = rows[0];
  touchCacheHit(key).catch(() => {});

  return {
    cacheKey: key,
    audioBase64: record.audio_base64,
    mouthCues: JSON.parse(record.mouth_cues_json || '[]'),
    cdnUrl: record.cdn_url || null
  };
};

const fetchCachedAudioByKey = async ({ cacheKey }) => {
  const transient = getTransientAudio(cacheKey);
  if (transient) {
    return transient;
  }

  const [rows] = await pool.execute(
    `SELECT audio_base64, mouth_cues_json, cdn_url
     FROM tts_cache
     WHERE cache_key = ?`,
    [cacheKey]
  );

  if (!rows.length) {
    return null;
  }

  return {
    cacheKey,
    audioBase64: rows[0].audio_base64,
    mouthCues: JSON.parse(rows[0].mouth_cues_json || '[]'),
    cdnUrl: rows[0].cdn_url || null
  };
};

const storeCachedAudio = async ({ personaId, language, text, variant, audioBase64, mouthCues, cdnUrl = null }) => {
  const key = buildCacheKey(personaId, language, text, variant);
  await pool.execute(
    `INSERT INTO tts_cache (cache_key, persona_id, language_code, variant, audio_base64, mouth_cues_json, cdn_url, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       audio_base64 = VALUES(audio_base64),
       mouth_cues_json = VALUES(mouth_cues_json),
       cdn_url = COALESCE(VALUES(cdn_url), cdn_url)`,
    [key, personaId, language, variant, audioBase64, JSON.stringify(mouthCues || []), cdnUrl]
  );

  return key;
};

const updateCacheMetadata = async ({ cacheKey, mouthCues, cdnUrl }) => {
  const updates = [];
  const values = [];

  if (Array.isArray(mouthCues)) {
    updates.push('mouth_cues_json = ?');
    values.push(JSON.stringify(mouthCues));
  }

  if (typeof cdnUrl === 'string' && cdnUrl.trim()) {
    updates.push('cdn_url = ?');
    values.push(cdnUrl.trim());
  }

  if (!updates.length) {
    return;
  }

  values.push(cacheKey);
  await pool.execute(
    `UPDATE tts_cache
     SET ${updates.join(', ')}
     WHERE cache_key = ?`,
    values
  );
};

const primeTransientAudio = ({ cacheKey, audioBase64, mouthCues = [], cdnUrl = null }) => {
  const existing = transientAudio.get(cacheKey);
  transientAudio.set(cacheKey, {
    cacheKey,
    audioBase64: audioBase64 ?? existing?.audioBase64 ?? null,
    mouthCues: Array.isArray(mouthCues) && mouthCues.length ? mouthCues : (existing?.mouthCues || []),
    cdnUrl: cdnUrl || existing?.cdnUrl || null,
    expiresAt: Date.now() + TRANSIENT_TTL_MS
  });
};

const getTransientAudio = (cacheKey) => {
  const cached = transientAudio.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt < Date.now()) {
    transientAudio.delete(cacheKey);
    return null;
  }

  return {
    cacheKey,
    audioBase64: cached.audioBase64,
    mouthCues: cached.mouthCues,
    cdnUrl: cached.cdnUrl
  };
};

const touchCacheHit = async (cacheKey) => {
  await pool.execute(
    `UPDATE tts_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE cache_key = ?`,
    [cacheKey]
  );
};

module.exports = {
  buildCacheKey,
  fetchCachedAudio,
  fetchCachedAudioByKey,
  storeCachedAudio,
  updateCacheMetadata,
  primeTransientAudio
};
