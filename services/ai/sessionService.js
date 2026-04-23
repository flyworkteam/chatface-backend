/**
 * sessionService.js — v2
 *
 * Data access for ai_sessions with call-state awareness.
 *
 * The rewrite splits session state in two:
 *   - `preferred_mode` (was `mode`): user preference hint only. Not
 *     authoritative for orchestration.
 *   - `active_mode`: currently-live mode. Flipped by /call/start and
 *     /call/end. Orchestrator may still override per-turn via the
 *     `conversationType` WS field.
 *   - `call_locked_language`: set when a call starts; STT + LLM hard-lock
 *     to this language for the duration of the call.
 *
 * Session row is never re-created on reconnect — personas must remember
 * conversations across modes (§4 of REWRITE_ARCHITECTURE.md).
 */

const { pool } = require('../../config/database');
const { normalizeLanguageCode } = require('./languageSupport');

const SELECT_COLUMNS = `
  id,
  user_id,
  persona_id,
  language_code,
  preferred_mode,
  active_mode,
  active_call_started_at,
  call_locked_language,
  last_seen_at
`;

const formatSession = (row) => ({
  id: row.id,
  userId: row.user_id,
  personaId: row.persona_id,
  language: row.language_code,
  preferredMode: row.preferred_mode,
  activeMode: row.active_mode,
  activeCallStartedAt: row.active_call_started_at,
  callLockedLanguage: row.call_locked_language,
  lastSeenAt: row.last_seen_at,
  // Back-compat shim for code that still reads session.mode — prefer
  // activeMode but fall back to preferredMode so old call sites don't
  // get `undefined`.
  mode: row.active_mode || row.preferred_mode
});

const getSessionById = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLUMNS}
       FROM ai_sessions
      WHERE id = ?`,
    [sessionId]
  );
  return rows[0] ? formatSession(rows[0]) : null;
};

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
  // IMPORTANT: language_code is the "preferred" session language for chat
  // mode. If a call is active, the orchestrator should be reading
  // call_locked_language, not this field. We still update it here so the
  // chat surface reflects the user's last detected language.
  await pool.execute(
    `UPDATE ai_sessions
        SET language_code = ?, last_seen_at = NOW()
      WHERE id = ?
        AND (call_locked_language IS NULL OR call_locked_language = ?)`,
    [normalizedLanguage, sessionId, normalizedLanguage]
  );
};

/**
 * Begin a call. Locks language + marks active_mode.
 * Returns the updated session row.
 *
 * This is idempotent — calling beginCall twice with the same parameters
 * is safe. Calling with a different language while a call is already
 * active will overwrite the lock (last-writer-wins; clients should call
 * /call/end between calls).
 */
const beginCall = async ({ sessionId, language, mode }) => {
  if (!sessionId) {
    throw new Error('beginCall: sessionId required');
  }
  const normalizedLang = normalizeLanguageCode(language);
  if (!normalizedLang) {
    throw new Error(`beginCall: unsupported language "${language}"`);
  }
  if (mode !== 'voice_call' && mode !== 'video_call') {
    throw new Error(`beginCall: mode must be voice_call or video_call, got "${mode}"`);
  }

  await pool.execute(
    `UPDATE ai_sessions
        SET active_mode = ?,
            call_locked_language = ?,
            active_call_started_at = NOW(),
            last_seen_at = NOW()
      WHERE id = ?`,
    [mode, normalizedLang, sessionId]
  );

  return getSessionById(sessionId);
};

/**
 * End a call. Releases the language lock and reverts active_mode to chat.
 * Safe to call when no call is active (no-op).
 */
const endCall = async ({ sessionId }) => {
  if (!sessionId) {
    throw new Error('endCall: sessionId required');
  }

  await pool.execute(
    `UPDATE ai_sessions
        SET active_mode = 'chat',
            call_locked_language = NULL,
            active_call_started_at = NULL,
            last_seen_at = NOW()
      WHERE id = ?`,
    [sessionId]
  );

  return getSessionById(sessionId);
};

/**
 * Get the current call state for a session without loading the full row.
 * Cheap enough to call in the hot path per-turn.
 */
const getCallState = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT active_mode, call_locked_language, active_call_started_at
       FROM ai_sessions
      WHERE id = ?`,
    [sessionId]
  );
  if (!rows[0]) {
    return null;
  }
  return {
    activeMode: rows[0].active_mode,
    lockedLanguage: rows[0].call_locked_language,
    activeCallStartedAt: rows[0].active_call_started_at,
    isCallActive: rows[0].active_mode !== 'chat'
  };
};

/**
 * Reconcile a potentially stale active_mode. If a call was marked active
 * but the session hasn't been seen in > staleAfterMs, treat the call as
 * abandoned and release the lock. Called on reconnect and on background
 * sweep.
 */
const reconcileStaleCall = async (sessionId, { staleAfterMs = 90 * 1000 } = {}) => {
  const [rows] = await pool.execute(
    `SELECT active_mode, last_seen_at
       FROM ai_sessions
      WHERE id = ?`,
    [sessionId]
  );
  if (!rows[0]) {
    return false;
  }
  if (rows[0].active_mode === 'chat') {
    return false;
  }
  const lastSeen = rows[0].last_seen_at ? new Date(rows[0].last_seen_at).getTime() : 0;
  if (Date.now() - lastSeen < staleAfterMs) {
    return false;
  }
  await endCall({ sessionId });
  return true;
};

module.exports = {
  getSessionById,
  touchSession,
  updateSessionLanguage,
  beginCall,
  endCall,
  getCallState,
  reconcileStaleCall
};
