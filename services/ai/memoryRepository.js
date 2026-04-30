const { pool } = require('../../config/database');

const DEFAULT_CONTEXT_WINDOW = 40;
const CACHE_TTL_MS = parseInt(process.env.PERSONA_CACHE_TTL_MS || '300000', 10);
const personaCache = new Map();
const personaVoiceCache = new Map();

const getCachedValue = (cache, key) => {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.value;
};

const setCachedValue = (cache, key, value) => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  return value;
};

const fetchRecentMessages = async (sessionId, limit = DEFAULT_CONTEXT_WINDOW) => {
  const [rows] = await pool.execute(
    `SELECT id, role, content_json, created_at
     FROM session_messages
     WHERE session_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [sessionId, limit]
  );

  return rows.reverse().map((row) => ({
    ...row,
    content: typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json
  }));
};

const fetchMessagesAfterId = async (sessionId, afterMessageId, limit = 100) => {
  const query = afterMessageId
    ? `SELECT id, role, content_json, created_at
       FROM session_messages
       WHERE session_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`
    : `SELECT id, role, content_json, created_at
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`;

  const params = afterMessageId ? [sessionId, afterMessageId, limit] : [sessionId, limit];

  const [rows] = await pool.execute(query, params);

  return rows.map((row) => ({
    ...row,
    content: typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json
  }));
};

const saveMessage = async ({ sessionId, role, content, historyVisible = true }) => {
  const [result] = await pool.execute(
    `INSERT INTO session_messages (session_id, role, content_json, history_visible)
     VALUES (?, ?, ?, ?)`,
    [sessionId, role, JSON.stringify(content), historyVisible ? 1 : 0]
  );

  const insertId = result.insertId;
  const [rows] = await pool.execute(
    `SELECT created_at
     FROM session_messages
     WHERE id = ?
     LIMIT 1`,
    [insertId]
  );

  return {
    id: insertId,
    createdAt: rows[0]?.created_at || new Date()
  };
};

const getPendingSessionsForSummary = async (minMessagesThreshold = 10) => {
  // Finds sessions that have more than `minMessagesThreshold` messages since
  // the latest saved summary (or since the beginning if no summary exists).
  const [rows] = await pool.execute(
    `SELECT
       sm.session_id,
       s.user_id,
       latest_summary.last_message_id AS last_summary_message_id,
       COUNT(sm.id) AS new_msg_count,
       MAX(sm.id) AS last_msg_id
     FROM session_messages sm
     INNER JOIN ai_sessions s ON s.id = sm.session_id
     LEFT JOIN (
       SELECT ms.session_id, ms.last_message_id
       FROM memory_summaries ms
       INNER JOIN (
         SELECT session_id, MAX(id) AS max_id
         FROM memory_summaries
         GROUP BY session_id
       ) latest ON latest.max_id = ms.id
     ) latest_summary ON latest_summary.session_id = sm.session_id
     WHERE latest_summary.last_message_id IS NULL
        OR sm.id > latest_summary.last_message_id
     GROUP BY sm.session_id, s.user_id, latest_summary.last_message_id
     HAVING new_msg_count >= ?`,
    [minMessagesThreshold]
  );
  return rows;
};

const saveMemorySummary = async ({ sessionId, summary, lastMessageId }) => {
  const [result] = await pool.execute(
    `INSERT INTO memory_summaries (session_id, summary, last_message_id)
     VALUES (?, ?, ?)`,
    [sessionId, summary, lastMessageId]
  );
  return result.insertId;
};

const getLatestMemorySummary = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT id, summary, last_message_id, created_at
     FROM memory_summaries
     WHERE session_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
};

const saveMemoryEntry = async ({ userId, type, languageCode = 'en', valueJson, embedding = null, salience = 0.0 }) => {
  const [result] = await pool.execute(
    `INSERT INTO memory_entries (user_id, type, language_code, value_json, embedding, salience)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, languageCode, JSON.stringify(valueJson), embedding ? JSON.stringify(embedding) : null, salience]
  );
  return result.insertId;
};

const getMemoryEntries = async (userId, type, languageCode) => {
  const [rows] = await pool.execute(
    `SELECT id, type, value_json, salience
     FROM memory_entries
     WHERE user_id = ? AND type = ? AND language_code = ?
     ORDER BY salience DESC`,
    [userId, type, languageCode]
  );
  return rows.map(r => ({
    ...r,
    value: typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json
  }));
};

const getPersonaById = async (personaId) => {
  const cacheKey = String(personaId);
  const cached = getCachedValue(personaCache, cacheKey);
  if (cached) {
    return cached;
  }

  const [rows] = await pool.execute(
    `SELECT id, name, description, prompt_template, short_description
     FROM persona_profiles
     WHERE id = ? AND active = 1`,
    [personaId]
  );

  const persona = rows[0] || null;
  if (!persona) {
    return null;
  }

  return setCachedValue(personaCache, cacheKey, persona);
};

const getPersonaVoice = async (personaId, language) => {
  const cacheKey = `${personaId}:${language}`;
  const cached = getCachedValue(personaVoiceCache, cacheKey);
  if (cached) {
    return cached;
  }

  const [rows] = await pool.execute(
    `SELECT persona_id, language_code, elevenlabs_voice_id, style, timbre, lip_sync_preset, sample_rate
     FROM persona_voices
     WHERE persona_id = ?
     ORDER BY CASE WHEN language_code = ? THEN 0 ELSE 1 END, language_code ASC
     LIMIT 1`,
    [personaId, language]
  );

  const voice = rows[0] || null;
  if (!voice) {
    return null;
  }

  return setCachedValue(personaVoiceCache, cacheKey, voice);
};

const getMessageById = async (messageId) => {
  const [rows] = await pool.execute(
    `SELECT id, session_id, role, content_json
     FROM session_messages
     WHERE id = ?`,
    [messageId]
  );

  if (!rows.length) {
    return null;
  }

  const row = rows[0];
  return {
    ...row,
    content: typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json
  };
};

const getUserById = async (userId) => {
  const [rows] = await pool.execute(
    `SELECT id, full_name, email, age, gender, country, preferred_language, about_me, 
            profile_picture_urls, is_premium, created_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId]
  );

  if (!rows.length) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    age: row.age,
    gender: row.gender,
    country: row.country,
    preferredLanguage: row.preferred_language,
    aboutMe: row.about_me,
    profilePictureUrls: row.profile_picture_urls,
    isPremium: row.is_premium,
    createdAt: row.created_at
  };
};

const recordUsage = async ({ sessionId, userId, llmIn, llmOut, ttsChars, latencyMs }) => {
  await pool.execute(
    `INSERT INTO usage_logs
      (session_id, user_id, llm_tokens_in, llm_tokens_out, tts_chars, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, llmIn, llmOut, ttsChars, latencyMs]
  );
};

module.exports = {
  fetchRecentMessages,
  saveMessage,
  getPersonaById,
  getPersonaVoice,
  getMessageById,
  recordUsage,
  getPendingSessionsForSummary,
  saveMemorySummary,
  getLatestMemorySummary,
  saveMemoryEntry,
  getMemoryEntries,
  fetchMessagesAfterId,
  getUserById
};
