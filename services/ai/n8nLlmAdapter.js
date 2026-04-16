/**
 * n8nLlmAdapter.js
 *
 * Replaces openaiAdapter.streamChatCompletion() when USE_N8N_LLM=true.
 *
 * Architecture:
 *   Node → POST n8n /webhook/ai-chat (with prompt + callbackUrl)
 *   n8n  → OpenAI streaming internally
 *   n8n  → POST Node /api/ai/internal/llm-sentence  (per sentence)
 *   n8n  → POST Node /api/ai/internal/llm-done      (when complete)
 *
 * Each in-flight LLM turn is tracked in `pendingTurns` by a unique turnId.
 * The sentence callback feeds individual characters into onDelta to maintain
 * full compatibility with SentenceAssembler in chatOrchestrator.
 */

const { v4: uuidv4 } = require('uuid');
const {
  getWebhookUrl,
  isN8nConfigured,
  validateNodeInternalBaseUrl,
  fireWebhook
} = require('../../config/n8n');
const { warn, log } = require('./logger');

const LLM_TURN_TIMEOUT_MS = parseInt(process.env.N8N_LLM_TIMEOUT_MS || '30000', 10);

// Map of turnId → { onSentence, resolve, reject, timeoutHandle }
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
  tokensOut = 0
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
    timestamp: new Date().toISOString()
  });
};

const rejectPendingTurn = (turnId, message, timeoutHandle) => {
  if (!pendingTurns.has(turnId)) {
    return;
  }
  const turn = pendingTurns.get(turnId);
  clearTimeout(timeoutHandle || turn?.timeoutHandle);
  pendingTurns.delete(turnId);
  emitN8nLlmCallAnalytics({ turn, status: 'error' });
  turn.reject(new Error(message));
};

/**
 * Called by the internal route when n8n POSTs a sentence callback.
 * Exported so routes/internal.js can wire it up.
 */
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

  // Feed characters one-by-one to preserve SentenceAssembler compatibility.
  // The assembler in chatOrchestrator.js listens for deltas and emits TTS chunks
  // when it detects sentence boundaries — passing a full sentence at once works too.
  turn.onDelta(normalizedSentence);
  // Add a space so the assembler sees a natural word boundary between sentences.
  turn.onDelta(' ');
};

/**
 * Called by the internal route when n8n POSTs the completion callback.
 */
const handleLlmDoneCallback = (turnId, fullText, tokensIn, tokensOut) => {
  const turn = pendingTurns.get(turnId);
  if (!turn) return;

  clearTimeout(turn.timeoutHandle);
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

/**
 * Called by the internal route when n8n reports an error.
 */
const handleLlmErrorCallback = (turnId, message) => {
  const turn = pendingTurns.get(turnId);
  if (!turn) return;

  clearTimeout(turn.timeoutHandle);
  pendingTurns.delete(turnId);
  emitN8nLlmCallAnalytics({ turn, status: 'error' });
  turn.reject(new Error(message || 'n8n LLM workflow error'));
};

/**
 * Drop-in replacement for streamChatCompletion() from openaiAdapter.js.
 * Same signature: { systemPrompt, messages, mode, onDelta } → { fullText, tokensIn, tokensOut }
 */
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
      return reject(new Error('n8n is not configured (N8N_WEBHOOK_BASE_URL / N8N_WEBHOOK_SECRET missing)'));
    }

    const nodeBaseValidation = validateNodeInternalBaseUrl();
    if (!nodeBaseValidation.ok) {
      return reject(new Error(nodeBaseValidation.issues.join(' | ')));
    }

    const turnId = uuidv4();
    const callbackBase = nodeBaseValidation.normalized.replace(/\/$/, '');
    const startedAt = Date.now();

    const timeoutHandle = setTimeout(() => {
      if (pendingTurns.has(turnId)) {
        pendingTurns.delete(turnId);
        warn('n8n LLM turn timed out', { turnId });
        emitN8nLlmCallAnalytics({
          turn: {
            mode,
            startedAt,
            requestAckMs: null,
            firstSentenceMs: null,
            analyticsContext
          },
          status: 'error'
        });
        reject(new Error('n8n LLM workflow timed out'));
      }
    }, LLM_TURN_TIMEOUT_MS);

    pendingTurns.set(turnId, {
      onDelta,
      resolve,
      reject,
      timeoutHandle,
      mode,
      startedAt,
      requestAckMs: null,
      firstSentenceMs: null,
      analyticsContext
    });

    const webhookUrl = getWebhookUrl('aiChat');
    log('n8n LLM request dispatched', { turnId, mode, webhookUrl });

    fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-n8n-secret': process.env.N8N_WEBHOOK_SECRET || ''
      },
      body: JSON.stringify({
        turnId,
        systemPrompt,
        messages,
        mode,
        openAiKey: process.env.OPENAI_API_KEY || '',
        openAiModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        sentenceCallbackUrl: `${callbackBase}/api/ai/internal/llm-sentence`,
        doneCallbackUrl: `${callbackBase}/api/ai/internal/llm-done`,
        errorCallbackUrl: `${callbackBase}/api/ai/internal/llm-error`
      })
    })
      .then(async (response) => {
        if (response.ok) {
          const turn = pendingTurns.get(turnId);
          if (turn) {
            turn.requestAckMs = Date.now() - startedAt;
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
          `n8n LLM webhook returned ${response.status}${errorText ? `: ${errorText}` : ''}`,
          timeoutHandle
        );
      })
      .catch((err) => {
        // If the POST itself fails (network error), reject immediately
        rejectPendingTurn(
          turnId,
          `n8n LLM webhook POST failed: ${err.message}`,
          timeoutHandle
        );
      });
  });
};

/**
 * Returns the count of in-flight LLM turns — useful for health checks.
 */
const getPendingTurnCount = () => pendingTurns.size;

module.exports = {
  streamChatCompletionViaN8n,
  handleLlmSentenceCallback,
  handleLlmDoneCallback,
  handleLlmErrorCallback,
  getPendingTurnCount
};
