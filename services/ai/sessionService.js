const { pool } = require('../../config/database');
const { normalizeLanguageCode } = require('./languageSupport');

const getSessionById = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT id, user_id, persona_id, language_code, mode, last_seen_at
     FROM ai_sessions
     WHERE id = ?`,
    [sessionId]
  );

  return rows[0] ? formatSession(rows[0]) : null;
};

const formatSession = (row) => ({
  id: row.id,
  userId: row.user_id,
  personaId: row.persona_id,
  language: row.language_code,
  mode: row.mode,
  lastSeenAt: row.last_seen_at
});

const touchSession = async (sessionId) => {
  await pool.execute(
    `UPDATE ai_sessions SET last_seen_at = NOW() WHERE id = ?`,
    [sessionId]
  );
};

const updateSessionLanguage = async (sessionId, languageCode) => {
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  if (!normalizedLanguage) {
    return;
  }
  await pool.execute(
    `UPDATE ai_sessions SET language_code = ?, last_seen_at = NOW() WHERE id = ?`,
    [normalizedLanguage, sessionId]
  );
};

module.exports = {
  getSessionById,
  touchSession,
  updateSessionLanguage
};
