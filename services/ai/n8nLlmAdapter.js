/**
 * n8nLlmAdapter.js — v2
 *
 * Replaces openaiAdapter.streamChatCompletion() when USE_N8N_LLM=true.
 *
 * Architecture:
 *   Node → POST n8n /webhook/ai-chat (with prompt + callbackUrl)
 *   n8n  → OpenAI streaming internally
 *   n8n  → POST Node /api/n8n/llm-sentence  (per sentence)
 *   n8n  → POST Node /api/n8n/llm-heartbeat (every ~2s while waiting for LLM)
 *   n8n  → POST Node /api/n8n/llm-done      (when complete)
 *
 * v2 changes:
 *  - Heartbeat callbacks reset the turn-level timeout so slow-but-alive
 *    LLM runs aren't killed by the 30s deadline. If we stop receiving
 *    heartbeats OR sentences for HEARTBEAT_GRACE_MS, we time out.
 *  - Pooled fetch via keep-alive agent (less TLS handshake cost on
 *    Hostinger → n8n hop).
 *  - Single retry on webhook POST failures (connection reset / 5xx)
 *    with a short backoff. Sentence/done callbacks are idempotent
 *    against the turnId, so duplicates are harmless.
 *  - Exports `pingTurn()` so internal routes can feed heartbeat timing.
 */

const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const {
  getWebhookUrl,
  isN8nConfigured,
  validateNodeInternalBaseUrl,
  fireWebhook
} = require('../../config/n8n');
const { warn, log } = require('./logger');

// Overall turn deadline — hard ceiling even with heartbeats, to prevent
// runaway turns.
const LLM_TURN_TIMEOUT_MS = parseInt(process.env.N8N_LLM_TIMEOUT_MS || '45000', 10);
// If we don't hear from n8n at all (no sentence / heartbeat / done) within
// this window, we give up.
const LLM_HEARTBEAT_GRACE_MS = parseInt(process.env.N8N_LLM_HEARTBEAT_GRACE_MS || '8000', 10);
// Post-failure retry.
const WEBHOOK_RETRY_DELAY_MS = parseInt(process.env.N8N_WEBHOOK_RETRY_MS || '250', 10);

const INTERNAL_CALLBACK_PATH_PREFIX =
  (process.env.N8N_INTERNAL_CALLBACK_PATH || '/api/n8n').replace(/\/+$/, '');

// Keep-alive agents — each fetch() without an agent re-opens the TCP/TLS
// connection. Since we POST to n8n on every voice turn, pool it.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const resolveAgent = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent);

// Map of turnId → turn state
const pendingTurns = new Map();
const normalizeSentence = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
const hasSpeakableChars = (value = '') => /[\p{L}\p{N}]/u.test(value);
const isInvalidSentence = (value = '') => {
  const normalized = normalizeSentence(value);
  if (!normalized || normalized.length < 2) {
    return true;
  }
  return !hasSpeakableChars(normalized);
};

const normalizeAnalyticsMode = (mode = 'chat') =>
  mode === 'voice' ? 'voice_call' : mode === 'video' ? 'video_call' : mode;

const emitN8nLlmCallAnalytics = ({
  turn,
  status = 'ok',
  tokensIn = 0,
  tokensOut = 0,
  retries = 0
}) => {
  if (!turn) {
    return;
  }

  const analyticsMode = normalizeAnalyticsMode(turn.mode || 'chat');
  const totalMs = Math.max(0, Date.now() - (turn.startedAt || Date.now()));

  fireWebhook('aiTurnAnalytics', {
    sessionId: turn.analyticsContext?.sessionId ?? null,
    userId: turn.analyticsContext?.userId ?? null,
    personaId: turn.analyticsContext?.personaId ?? null,
    mode: analyticsMode,
    language: turn.analyticsContext?.language ?? null,
    llmIn: Math.round(tokensIn || 0),
    llmOut: Math.round(tokensOut || 0),
    ttsChars: 0,
    latencyMs: totalMs,
    timings: {
      prepMs: turn.requestAckMs ?? null,
      llmFirstTokenMs: turn.firstSentenceMs ?? null,
      firstSentenceMs: turn.firstSentenceMs ?? null,
      totalMs
    },
    viaN8nLlm: true,
    n8nCallOnly: true,
    n8nCallStatus: status,
    n8nCallRetries: retries,
    timestamp: new Date().toISOString()
  });
};

const clearTurnTimers = (turn) => {
  if (turn?.overallTimeout) clearTimeout(turn.overallTimeout);
  if (turn?.heartbeatTimeout) clearTimeout(turn.heartbeatTimeout);
};

const armHeartbeatTimeout = (turn) => {
  if (!turn) return;
  if (turn.heartbeatTimeout) clearTimeout(turn.heartbeatTimeout);
  turn.heartbeatTimeout = setTimeout(() => {
    if (!pendingTurns.has(turn.turnId)) return;
    warn('n8n LLM turn timed out (no heartbeat)', { turnId: turn.turnId });
    rejectPendingTurn(turn.turnId, 'n8n LLM workflow stalled (no heartbeat)');
  }, LLM_HEARTBEAT_GRACE_MS);
  if (turn.heartbeatTimeout.unref) turn.heartbeatTimeout.unref();
};

const pingTurn = (turnId) => {
  const turn = pendingTurns.get(turnId);
  if (!turn) return;
  turn.lastHeartbeatAt = Date.now();
  armHeartbeatTimeout(turn);
};

const rejectPendingTurn = (turnId, message) => {
  const turn = pendingTurns.get(turnId);
  if (!turn) return;
  clearTurnTimers(turn);
  pendingTurns.delete(turnId);
  emitN8nLlmCallAnalytics({ turn, status: 'error' });
  turn.reject(new Error(message));
};

const handleLlmSentenceCallback = (turnId, sentence, index) => {
  const turn = pendingTurns.get(turnId);
  if (!turn || !sentence) return;
  const normalizedSentence = normalizeSentence(sentence);
  if (isInvalidSentence(normalizedSentence)) {
    warn('n8n LLM sentence callback suppressed due to invalid text', {
      turnId,
      index,
      preview: normalizedSentence.slice(0, 80)
    });
    return;
  }
  if (!turn.firstSentenceMs) {
    turn.firstSentenceMs = Date.now() - turn.startedAt;
  }
  // Heartbeat-equivalent: a real sentence means the workflow is alive.
  turn.lastHeartbeatAt = Date.now();
  armHeartbeatTimeout(turn);

  turn.onDelta(normalizedSentence);
  turn.onDelta(' ');
};

const handleLlmDoneCallback = (turnId, fullText, tokensIn, tokensOut) => {
  const turn = pendingTurns.get(turnId);
  if (!turn) return;

  clearTurnTimers(turn);
  pendingTurns.delete(turnId);
  emitN8nLlmCallAnalytics({
    turn,
    status: 'ok',
    tokensIn,
    tokensOut
  });
  turn.resolve({
    fullText: fullText || '',
    tokensIn: tokensIn || 0,
    tokensOut: tokensOut || 0
  });
};

const handleLlmErrorCallback = (turnId, message) => {
  const turn = pendingTurns.get(turnId);
  if (!turn) return;

  clearTurnTimers(turn);
  pendingTurns.delete(turnId);
  emitN8nLlmCallAnalytics({ turn, status: 'error' });
  turn.reject(new Error(message || 'n8n LLM workflow error'));
};

// Fetch with keep-alive agent + one retry on transport / 5xx failures.
const postWithRetry = async (url, body, { retryCount = 1 } = {}) => {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        // Node's built-in fetch (undici) accepts `dispatcher`, but `agent`
        // is ignored. We leave both in — harmless on undici, useful if
        // someone swaps in node-fetch.
        agent: resolveAgent(url)
      });
      if (response.ok || response.status < 500 || attempt > retryCount) {
        return { response, attempts: attempt };
      }
      // Retriable 5xx — fall through to retry.
    } catch (err) {
      if (attempt > retryCount) {
        throw err;
      }
    }
    // Short backoff.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, WEBHOOK_RETRY_DELAY_MS));
  }
};

const streamChatCompletionViaN8n = ({
  systemPrompt,
  messages,
  mode = 'chat',
  onDelta,
  analyticsContext = {}
}) => {
  return new Promise((resolve, reject) => {
    if (!isN8nConfigured()) {
      warn('n8n LLM adapter: n8n is not configured, falling back to error');
      return reject(new Error('n8n is not configured (N8N_WEBHOOK_BASE_URL missing)'));
    }

    const nodeBaseValidation = validateNodeInternalBaseUrl();
    if (!nodeBaseValidation.ok) {
      return reject(new Error(nodeBaseValidation.issues.join(' | ')));
    }

    const turnId = uuidv4();
    const callbackBase = nodeBaseValidation.normalized.replace(/\/$/, '');
    const startedAt = Date.now();

    const overallTimeout = setTimeout(() => {
      if (pendingTurns.has(turnId)) {
        warn('n8n LLM turn hit hard deadline', { turnId });
        rejectPendingTurn(turnId, 'n8n LLM workflow timed out');
      }
    }, LLM_TURN_TIMEOUT_MS);
    if (overallTimeout.unref) overallTimeout.unref();

    const turn = {
      turnId,
      onDelta,
      resolve,
      reject,
      overallTimeout,
      heartbeatTimeout: null,
      mode,
      startedAt,
      lastHeartbeatAt: startedAt,
      requestAckMs: null,
      firstSentenceMs: null,
      analyticsContext
    };
    pendingTurns.set(turnId, turn);
    armHeartbeatTimeout(turn);

    const webhookUrl = getWebhookUrl('aiChat');
    log('n8n LLM request dispatched', { turnId, mode, webhookUrl });

    const body = JSON.stringify({
      turnId,
      systemPrompt,
      messages,
      mode,
      openAiKey: process.env.OPENAI_API_KEY || '',
      openAiModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      sentenceCallbackUrl: `${callbackBase}${INTERNAL_CALLBACK_PATH_PREFIX}/llm-sentence`,
      heartbeatCallbackUrl: `${callbackBase}${INTERNAL_CALLBACK_PATH_PREFIX}/llm-heartbeat`,
      doneCallbackUrl: `${callbackBase}${INTERNAL_CALLBACK_PATH_PREFIX}/llm-done`,
      errorCallbackUrl: `${callbackBase}${INTERNAL_CALLBACK_PATH_PREFIX}/llm-error`
    });

    postWithRetry(webhookUrl, body, { retryCount: 1 })
      .then(async ({ response, attempts }) => {
        if (response.ok) {
          const live = pendingTurns.get(turnId);
          if (live) {
            live.requestAckMs = Date.now() - startedAt;
            live.retries = attempts - 1;
          }
          return;
        }
        let errorText = '';
        try {
          errorText = (await response.text()).slice(0, 300);
        } catch (_err) {
          errorText = '';
        }
        rejectPendingTurn(
          turnId,
          `n8n LLM webhook returned ${response.status}${errorText ? `: ${errorText}` : ''}`
        );
      })
      .catch((err) => {
        rejectPendingTurn(
          turnId,
          `n8n LLM webhook POST failed: ${err.message}`
        );
      });
  });
};

const getPendingTurnCount = () => pendingTurns.size;

module.exports = {
  streamChatCompletionViaN8n,
  handleLlmSentenceCallback,
  handleLlmDoneCallback,
  handleLlmErrorCallback,
  pingTurn,
  getPendingTurnCount
};
