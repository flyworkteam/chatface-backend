require('dotenv').config();

const n8nConfig = {
  baseUrl: process.env.N8N_WEBHOOK_BASE_URL || '',

  webhooks: {
    // Legacy lifecycle hooks
    userRegistered: '/user-registered',
    onboardingCompleted: '/onboarding-completed',
    faceScanCompleted: '/face-scan-completed',

    // Phase 2 — LLM orchestration
    aiChat: '/ai-chat',

    // Phase 3 — TTS synthesis
    ttsSynthesize: '/tts-synthesize',

    // Phase 4 — Async background workflows
    moderationCheck: '/moderation-check',
    aiTurnAnalytics: '/ai-turn-analytics',
    ttsCacheWarmer: '/tts-cache-warmer',
    personaConfig: '/persona-config'
  }
};

/**
 * Returns true when n8n base URL is configured.
 * Webhook secret is optional (depends on n8n webhook auth mode).
 */
const isN8nConfigured = () =>
  !!n8nConfig.baseUrl;

const normalizeBaseUrl = (value = '') => String(value || '').replace(/\/+$/, '');
const normalizeWebhookPath = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const validateNodeInternalBaseUrl = () => {
  const issues = [];
  const warnings = [];
  const raw = (process.env.NODE_INTERNAL_BASE_URL || '').trim();
  const requiresCallbackUrl =
    process.env.USE_N8N_LLM === 'true' ||
    process.env.USE_N8N_MODERATION_ASYNC === 'true';

  if (!raw) {
    if (requiresCallbackUrl) {
      issues.push('NODE_INTERNAL_BASE_URL is required when USE_N8N_LLM=true or USE_N8N_MODERATION_ASYNC=true');
    }
    return {
      ok: issues.length === 0,
      issues,
      warnings,
      normalized: ''
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_err) {
    if (requiresCallbackUrl) {
      issues.push('NODE_INTERNAL_BASE_URL must be a valid absolute URL (http/https).');
    } else {
      warnings.push('NODE_INTERNAL_BASE_URL is not a valid absolute URL (http/https).');
    }
    return {
      ok: issues.length === 0,
      issues,
      warnings,
      normalized: ''
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol) && requiresCallbackUrl) {
    issues.push('NODE_INTERNAL_BASE_URL protocol must be http or https.');
  }

  if (parsed.protocol === 'https:' && parsed.port === '3000') {
    const message = 'Invalid NODE_INTERNAL_BASE_URL: do not use https://...:3000. Use your public TLS URL without :3000.';
    if (requiresCallbackUrl) {
      issues.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (parsed.protocol === 'http:' && parsed.port === '443') {
    warnings.push('NODE_INTERNAL_BASE_URL uses http with port 443. Verify this is intentional.');
  }

  if (process.env.NODE_ENV === 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    warnings.push('NODE_INTERNAL_BASE_URL points to localhost in production. n8n callbacks may fail.');
  }

  if (parsed.pathname && parsed.pathname !== '/' && requiresCallbackUrl) {
    warnings.push('NODE_INTERNAL_BASE_URL should be host-level (no path). Callback paths are appended automatically.');
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    normalized: `${parsed.protocol}//${parsed.host}`
  };
};

const assertRuntimeN8nConfig = () => {
  const strict = process.env.N8N_CONFIG_STRICT === 'true' || process.env.NODE_ENV === 'production';
  const result = validateNodeInternalBaseUrl();

  result.warnings.forEach((warning) => {
    console.warn(`⚠️  ${warning}`);
  });

  if (result.issues.length) {
    const message = result.issues.join(' | ');
    if (strict) {
      throw new Error(`n8n runtime configuration error: ${message}`);
    }
    console.warn(`⚠️  n8n runtime configuration error: ${message}`);
  }

  return result;
};

/**
 * Returns the full URL for a named webhook path.
 * Pass either a key from n8nConfig.webhooks or a raw path string starting with '/'.
 *
 * @param {string} webhookPathOrKey
 * @returns {string|null}
 */
const getWebhookUrl = (webhookPathOrKey) => {
  if (!isN8nConfigured()) {
    console.warn('⚠️  n8n is not configured (N8N_WEBHOOK_BASE_URL missing)');
    return null;
  }
  const path = normalizeWebhookPath(n8nConfig.webhooks[webhookPathOrKey] ?? webhookPathOrKey);
  return `${normalizeBaseUrl(n8nConfig.baseUrl)}${path}`;
};

/**
 * Fire a webhook to n8n without awaiting the response (true fire-and-forget).
 * Errors are swallowed — never let background n8n calls crash the hot path.
 *
 * @param {string} webhookPathOrKey
 * @param {object} body
 */
const fireWebhook = (webhookPathOrKey, body = {}) => {
  const url = getWebhookUrl(webhookPathOrKey);
  if (!url) return;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }).catch((err) => {
    console.warn(`⚠️  n8n webhook fire failed (${webhookPathOrKey}):`, err.message);
  });
};

const runN8nStartupSmokeChecks = async () => {
  if (!isN8nConfigured()) {
    return [];
  }

  const checks = [
    { key: 'aiChat', body: { healthcheck: true } },
    { key: 'ttsSynthesize', body: { healthcheck: true } },
    { key: 'aiTurnAnalytics', body: { healthcheck: true } }
  ];

  const timeoutMs = parseInt(process.env.N8N_SMOKE_TIMEOUT_MS || '6000', 10);
  const results = [];

  for (const check of checks) {
    const url = getWebhookUrl(check.key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(check.body),
        signal: controller.signal
      });
      results.push({
        key: check.key,
        ok: response.ok,
        status: response.status
      });
    } catch (error) {
      results.push({
        key: check.key,
        ok: false,
        status: 0,
        error: error.message
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return results;
};

module.exports = {
  n8nConfig,
  isN8nConfigured,
  validateNodeInternalBaseUrl,
  assertRuntimeN8nConfig,
  getWebhookUrl,
  fireWebhook,
  runN8nStartupSmokeChecks
};
