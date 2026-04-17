/**
 * internalAuth.js
 *
 * Secret-based internal auth is intentionally disabled.
 * n8n/internal callbacks are allowed without internal secret checks.
 */
const requireInternalAuth = (_req, _res, next) => next();

module.exports = { requireInternalAuth };
