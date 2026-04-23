/**
 * fillerAudioService.js
 *
 * Runtime lookup for pre-rendered filler/placeholder audio clips.
 *
 * The filler audio is authored by `fillerAudioCatalog.js`, pre-rendered by
 * the n8n `filler-audio` workflow at persona create / update, and pushed to
 * BunnyCDN. This service is the *read* side: given a persona + language +
 * scenario, return a ready-to-play clip with mouth cues.
 *
 * Design notes:
 *  - We never synthesize in the hot path. If the cache is cold, we return
 *    null and let the orchestrator silently continue (better to be quiet
 *    than to block the conversation on TTS).
 *  - Variant rotation is "don't repeat the last two" per (session, scenario)
 *    — prevents the uncanny loop of hearing the same "hmm…" three times.
 *  - In-process cache keyed by (persona_id, language) keeps DB load flat
 *    (fillers are stable between persona updates).
 *  - Cache invalidation happens via `invalidatePersona(personaId)` — wired
 *    to persona update/delete controllers.
 *
 * See REWRITE_ARCHITECTURE.md §8.
 */

const { pool } = require('../../config/database');
const {
  SCENARIOS,
  SUPPORTED_LANGUAGES,
  getPhrases
} = require('./fillerAudioCatalog');
const { normalizeLanguageCode } = require('./languageSupport');

// -- in-process caches -------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min, persona edits are rare
const personaCache = new Map(); // key: personaId|lang -> { rows, loadedAt }
const recentVariantsBySession = new Map(); // key: sessionId|scenario -> [variantIdx]
const RECENT_VARIANT_MEMORY = 2;
const RECENT_VARIANT_TTL_MS = 60 * 1000;
const sessionVariantExpiryTimers = new Map();

const cacheKey = (personaId, language) => `${personaId}|${language}`;
const sessionKey = (sessionId, scenario) => `${sessionId}|${scenario}`;

// -- DB layer ----------------------------------------------------------------

const loadCacheForPersonaLang = async (personaId, language) => {
  const [rows] = await pool.execute(
    `SELECT id, persona_id, language_code, scenario, variant_index,
            text, cdn_url, duration_ms, mouth_cues_json
       FROM filler_audio_cache
      WHERE persona_id = ?
        AND language_code = ?`,
    [personaId, language]
  );

  return rows.map((row) => ({
    id: row.id,
    personaId: row.persona_id,
    language: row.language_code,
    scenario: row.scenario,
    variantIndex: row.variant_index,
    text: row.text,
    cdnUrl: row.cdn_url,
    durationMs: row.duration_ms,
    mouthCues: row.mouth_cues_json
      ? (typeof row.mouth_cues_json === 'string'
        ? safeParseJson(row.mouth_cues_json)
        : row.mouth_cues_json)
      : null
  }));
};

const safeParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
};

const getRowsForPersonaLang = async (personaId, language) => {
  const key = cacheKey(personaId, language);
  const cached = personaCache.get(key);
  const now = Date.now();
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.rows;
  }
  const rows = await loadCacheForPersonaLang(personaId, language);
  personaCache.set(key, { rows, loadedAt: now });
  return rows;
};

// -- recent-variant tracking -------------------------------------------------

const scheduleSessionVariantExpiry = (sessionId) => {
  if (sessionVariantExpiryTimers.has(sessionId)) {
    return;
  }
  const timer = setTimeout(() => {
    clearRecentVariants(sessionId);
  }, RECENT_VARIANT_TTL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  sessionVariantExpiryTimers.set(sessionId, timer);
};

const rememberVariant = (sessionId, scenario, variantIndex) => {
  if (!sessionId) {
    return;
  }
  const key = sessionKey(sessionId, scenario);
  const list = recentVariantsBySession.get(key) || [];
  list.push(variantIndex);
  while (list.length > RECENT_VARIANT_MEMORY) {
    list.shift();
  }
  recentVariantsBySession.set(key, list);
  scheduleSessionVariantExpiry(sessionId);
};

const getRecentVariants = (sessionId, scenario) => {
  if (!sessionId) {
    return [];
  }
  return recentVariantsBySession.get(sessionKey(sessionId, scenario)) || [];
};

const clearRecentVariants = (sessionId) => {
  if (!sessionId) {
    return;
  }
  const prefix = `${sessionId}|`;
  Array.from(recentVariantsBySession.keys())
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => recentVariantsBySession.delete(key));
  const timer = sessionVariantExpiryTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionVariantExpiryTimers.delete(sessionId);
  }
};

// -- variant selection -------------------------------------------------------

const pickBestVariant = (rows, recentVariants) => {
  if (!rows.length) {
    return null;
  }
  // Prefer rows whose variantIndex isn't in the recent set.
  const recentSet = new Set(recentVariants);
  const fresh = rows.filter((row) => !recentSet.has(row.variantIndex));
  const pool_ = fresh.length ? fresh : rows;
  const index = Math.floor(Math.random() * pool_.length);
  return pool_[index];
};

// -- public API --------------------------------------------------------------

/**
 * Look up a filler clip.
 *
 * @param {object} params
 * @param {string} params.personaId
 * @param {string} params.language      ISO 639-1 code — falls back to 'en'.
 * @param {string} params.scenario      One of SCENARIOS.
 * @param {string} [params.sessionId]   For variant rotation.
 * @returns {Promise<null|{
 *   cdnUrl: string,
 *   mouthCues: object|null,
 *   durationMs: number,
 *   variantIndex: number,
 *   language: string,
 *   scenario: string,
 *   text: string
 * }>}
 */
const getFiller = async ({ personaId, language, scenario, sessionId = null }) => {
  if (!personaId || !scenario || !SCENARIOS.includes(scenario)) {
    return null;
  }

  const normalizedLang = normalizeLanguageCode(language, 'en') || 'en';
  const languageChain = [];
  languageChain.push(normalizedLang);
  if (normalizedLang !== 'en') {
    languageChain.push('en'); // last-resort fallback if persona lacks this lang
  }

  for (const lang of languageChain) {
    const rows = await getRowsForPersonaLang(personaId, lang);
    const matches = rows.filter((row) => row.scenario === scenario);
    if (!matches.length) {
      continue;
    }
    const recent = getRecentVariants(sessionId, scenario);
    const picked = pickBestVariant(matches, recent);
    if (!picked) {
      continue;
    }
    if (sessionId) {
      rememberVariant(sessionId, scenario, picked.variantIndex);
    }
    return {
      cdnUrl: picked.cdnUrl,
      mouthCues: picked.mouthCues,
      durationMs: picked.durationMs,
      variantIndex: picked.variantIndex,
      language: picked.language,
      scenario: picked.scenario,
      text: picked.text
    };
  }

  return null;
};

/**
 * Return the text phrases the n8n pre-render workflow should synthesize
 * for a given (language, scenario). Used by controllers that schedule
 * pre-rendering after persona creates / updates.
 */
const getRenderManifest = (personaId) => {
  const manifest = [];
  SUPPORTED_LANGUAGES.forEach((language) => {
    SCENARIOS.forEach((scenario) => {
      const phrases = getPhrases(language, scenario);
      phrases.forEach((text, variantIndex) => {
        manifest.push({
          personaId,
          language,
          scenario,
          variantIndex,
          text
        });
      });
    });
  });
  return manifest;
};

/**
 * Drop in-process caches for a persona (called after a persona is updated
 * or its voice changes, so the next lookup re-reads from DB).
 */
const invalidatePersona = (personaId) => {
  if (!personaId) {
    return;
  }
  const prefix = `${personaId}|`;
  Array.from(personaCache.keys())
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => personaCache.delete(key));
};

const getFillerManifestForPersona = async (personaId, languageCode) => {
  const cacheKeyStr = cacheKey(personaId, languageCode);
  const hot = personaCache.get(cacheKeyStr);
  
  if (hot) {
    if (Date.now() - hot.loadedAt < CACHE_TTL_MS) {
      return hot.rows;
    }
  }

  const rows = await loadCacheForPersonaLang(personaId, languageCode);
  personaCache.set(cacheKeyStr, { rows, loadedAt: Date.now() });
  return rows;
};

const saveFillerAudio = async ({ personaId, languageCode, scenario, variantIndex, text, cdnUrl, durationMs, mouthCuesJson }) => {
  const [result] = await pool.execute(
    `INSERT INTO filler_audio_cache 
       (persona_id, language_code, scenario, variant_index, text, cdn_url, duration_ms, mouth_cues_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE 
       text = VALUES(text),
       cdn_url = VALUES(cdn_url),
       duration_ms = VALUES(duration_ms),
       mouth_cues_json = VALUES(mouth_cues_json)`,
    [personaId, languageCode, scenario, variantIndex, text, cdnUrl, durationMs, mouthCuesJson]
  );
  invalidatePersona(personaId);
  return result.insertId || result.affectedRows;
};

const invalidateAll = () => {
  personaCache.clear();
};

module.exports = {
  getFiller,
  getRenderManifest,
  getFillerManifestForPersona,
  saveFillerAudio,
  invalidatePersona,
  invalidateAll,
  clearRecentVariants,
  // internals exposed for tests
  _personaCache: personaCache,
  _recentVariantsBySession: recentVariantsBySession
};
