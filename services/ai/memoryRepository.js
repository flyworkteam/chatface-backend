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

const getPersonaById = async (personaId) => {
  const cacheKey = String(personaId);
  const cached = getCachedValue(personaCache, cacheKey);
  if (cached) {
    return cached;
  }

  const [rows] = await pool.execute(
    `SELECT id, name, description, prompt_template, default_language
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
  recordUsage
};
