const crypto = require('crypto');
const { pool } = require('../../config/database');

const buildCacheKey = (personaId, language, text, variant) => {
  return crypto.createHash('sha1').update(`${personaId}:${language}:${variant}:${text}`).digest('hex');
};

const fetchCachedAudio = async ({ personaId, language, text, variant }) => {
  const key = buildCacheKey(personaId, language, text, variant);
  const [rows] = await pool.execute(
    `SELECT audio_base64, mouth_cues_json, hit_count
     FROM tts_cache
     WHERE cache_key = ?`,
    [key]
  );

  if (!rows.length) {
    return null;
  }

  const record = rows[0];
  await pool.execute(
    `UPDATE tts_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE cache_key = ?`,
    [key]
  );

  return {
    cacheKey: key,
    audioBase64: record.audio_base64,
    mouthCues: JSON.parse(record.mouth_cues_json || '[]')
  };
};

const fetchCachedAudioByKey = async ({ cacheKey }) => {
  const [rows] = await pool.execute(
    `SELECT audio_base64, mouth_cues_json
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
    mouthCues: JSON.parse(rows[0].mouth_cues_json || '[]')
  };
};

const storeCachedAudio = async ({ personaId, language, text, variant, audioBase64, mouthCues }) => {
  const key = buildCacheKey(personaId, language, text, variant);
  await pool.execute(
    `INSERT INTO tts_cache (cache_key, persona_id, language_code, variant, audio_base64, mouth_cues_json, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE audio_base64 = VALUES(audio_base64), mouth_cues_json = VALUES(mouth_cues_json)`,
    [key, personaId, language, variant, audioBase64, JSON.stringify(mouthCues || [])]
  );

  return key;
};

module.exports = {
  buildCacheKey,
  fetchCachedAudio,
  fetchCachedAudioByKey,
  storeCachedAudio
};
