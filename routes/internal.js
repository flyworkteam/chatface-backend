/**
 * routes/internal.js
 *
 * Internal callback routes called by n8n workflows.
 * Mounted at /api/n8n — no auth for now (both VPS on same Hostinger datacenter).
 *
 * Phase 2 routes: LLM sentence/done/error callbacks from n8n ai-chat workflow
 * Phase 3 routes: TTS prime-cache callback from n8n tts-cache-warmer workflow
 */

const express = require('express');
const router = express.Router();
const {
  handleLlmSentenceCallback,
  handleLlmDoneCallback,
  handleLlmErrorCallback,
  pingTurn,
  getPendingTurnCount
} = require('../services/ai/n8nLlmAdapter');
const { primeTransientAudio } = require('../services/ai/ttsCacheService');
const { getTopTtsCacheMisses } = require('../services/ai/ttsWarmQueue');
const { warn, log } = require('../services/ai/logger');
const {
  runN8nStartupSmokeChecks,
  validateNodeInternalBaseUrl
} = require('../config/n8n');
const { saveFillerAudio } = require('../services/ai/fillerAudioService');
const {
  getPendingSessionsForSummary,
  saveMemorySummary,
  saveMemoryEntry,
  fetchMessagesAfterId,
  getLatestMemorySummary
} = require('../services/ai/memoryRepository');

const SMOKE_TIMEOUT_MS = parseInt(process.env.N8N_SMOKE_TIMEOUT_MS || '6000', 10);
const CALLBACK_PATH_PREFIX =
  (process.env.N8N_INTERNAL_CALLBACK_PATH || '/api/n8n').replace(/\/+$/, '');

const requestJson = async ({ url, method = 'GET', body = null }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SMOKE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    let text = '';
    try {
      text = await response.text();
    } catch (_err) {
      text = '';
    }

    return {
      ok: response.ok,
      status: response.status,
      body: text.slice(0, 280)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ── Phase 2: LLM callbacks ────────────────────────────────────────────────

/**
 * n8n posts here for each assembled sentence during LLM generation.
 * Body: { turnId, sentence, index }
 */
router.post('/llm-sentence', (req, res) => {
  const { turnId, sentence, index } = req.body || {};
  if (!turnId) {
    return res.status(400).json({ error: 'turnId required' });
  }
  handleLlmSentenceCallback(turnId, sentence, index);
  res.sendStatus(200);
});

/**
 * n8n posts here when the LLM response is fully complete.
 * Body: { turnId, fullText, tokensIn, tokensOut }
 */
router.post('/llm-done', (req, res) => {
  const { turnId, fullText, tokensIn, tokensOut } = req.body || {};
  if (!turnId) {
    return res.status(400).json({ error: 'turnId required' });
  }
  handleLlmDoneCallback(turnId, fullText, tokensIn, tokensOut);
  res.sendStatus(200);
});

/**
 * n8n posts here every ~2s while the LLM is thinking, as a liveness
 * signal. Resets the heartbeat-grace timeout so long-but-alive generations
 * don't get killed by the stall detector. Body: { turnId, stage? }
 */
router.post('/llm-heartbeat', (req, res) => {
  const { turnId } = req.body || {};
  if (!turnId) {
    return res.status(400).json({ error: 'turnId required' });
  }
  pingTurn(turnId);
  res.sendStatus(204);
});

/**
 * n8n posts here if the LLM workflow encounters an error.
 * Body: { turnId, message }
 */
router.post('/llm-error', (req, res) => {
  const { turnId, message } = req.body || {};
  if (!turnId) {
    return res.status(400).json({ error: 'turnId required' });
  }
  warn('n8n LLM workflow error callback', { turnId, message });
  handleLlmErrorCallback(turnId, message);
  res.sendStatus(200);
});

// ── Phase 3: TTS cache callbacks ──────────────────────────────────────────

/**
 * n8n cache-warmer posts here after pre-synthesizing a phrase.
 * Body: { cacheKey, audioBase64, mouthCues? }
 */
router.post('/prime-cache', (req, res) => {
  const { cacheKey, audioBase64, mouthCues } = req.body || {};
  if (!cacheKey || !audioBase64) {
    return res.status(400).json({ error: 'cacheKey and audioBase64 required' });
  }
  try {
    primeTransientAudio({ cacheKey, audioBase64, mouthCues: mouthCues || [], cdnUrl: null });
    log('TTS cache primed via n8n', { cacheKey });
    res.sendStatus(200);
  } catch (err) {
    warn('Failed to prime TTS cache from n8n', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 4: Async memory summarization ────────────────────────────────────

/**
 * n8n workflow fetches sessions that have grown too large and need a summary.
 */
router.get('/memory/pending', async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold || '10', 10);
    const sessions = await getPendingSessionsForSummary(threshold);
    
    // For each session, fetch the new messages to be summarized
    const pendingData = [];
    for (const session of sessions) {
      const messages = await fetchMessagesAfterId(
        session.session_id,
        session.last_summary_message_id || null,
        50
      );
      const latestSummary = await getLatestMemorySummary(session.session_id);
      
      pendingData.push({
        sessionId: session.session_id,
        userId: session.user_id,
        newMessagesCount: session.new_msg_count,
        lastMessageId: session.last_msg_id,
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content
        })),
        previousSummary: latestSummary ? latestSummary.summary : null
      });
    }

    res.json({ pending: pendingData });
  } catch (err) {
    warn('Failed to fetch pending memory sessions', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * n8n workflow saves the new summary back here.
 */
router.post('/memory/summary', async (req, res) => {
  const { sessionId, summary, lastMessageId } = req.body || {};
  if (!sessionId || !summary || !lastMessageId) {
    return res.status(400).json({ error: 'sessionId, summary, and lastMessageId required' });
  }
  try {
    await saveMemorySummary({ sessionId, summary, lastMessageId });
    log('Memory summary updated via n8n', { sessionId, lastMessageId });
    res.sendStatus(200);
  } catch (err) {
    warn('Failed to save memory summary from n8n', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * n8n workflow saves extracted entities (facts, preferences).
 */
router.post('/memory/entries', async (req, res) => {
  const { userId, type, languageCode, valueJson, embedding, salience } = req.body || {};
  if (!userId || !type || !valueJson) {
    return res.status(400).json({ error: 'userId, type, and valueJson required' });
  }
  try {
    const id = await saveMemoryEntry({ userId, type, languageCode, valueJson, embedding, salience });
    log('Memory entry added via n8n', { userId, type, entryId: id });
    res.sendStatus(200);
  } catch (err) {
    warn('Failed to save memory entry from n8n', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * n8n workflow saves newly rendered filler audio.
 */
router.post('/filler-audio/cache', async (req, res) => {
  const { personaId, languageCode, scenario, variantIndex, text, cdnUrl, durationMs, mouthCuesJson } = req.body || {};
  if (!personaId || !languageCode || !scenario || variantIndex === undefined || !cdnUrl) {
    return res.status(400).json({ error: 'Missing required filler audio fields' });
  }
  try {
    await saveFillerAudio({
      personaId,
      languageCode,
      scenario,
      variantIndex,
      text: text || '',
      cdnUrl,
      durationMs: durationMs || 0,
      mouthCuesJson: mouthCuesJson ? JSON.stringify(mouthCuesJson) : '[]'
    });
    log('Filler audio cache updated via n8n', { personaId, scenario, variantIndex });
    res.sendStatus(200);
  } catch (err) {
    warn('Failed to save filler audio from n8n', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 5: Async moderation/cache warmer callbacks ──────────────────────

/**
 * Optional callback endpoint used by n8n moderation-check workflow.
 * Body: { sessionId, userId, turnId?, blocked, reason?, flaggedCategories? }
 */
router.post('/moderation-result', (req, res) => {
  const { sessionId, userId, turnId, blocked, reason, flaggedCategories } = req.body || {};
  if (!sessionId || !userId) {
    return res.status(400).json({ error: 'sessionId and userId required' });
  }

  if (blocked) {
    warn('Async moderation result received (blocked)', {
      sessionId,
      userId,
      turnId,
      reason: reason || 'content_policy',
      flaggedCategories: Array.isArray(flaggedCategories) ? flaggedCategories : []
    });
  } else {
    log('Async moderation result received (allowed)', { sessionId, userId, turnId });
  }

  res.sendStatus(200);
});

/**
 * Returns the hottest recent TTS cache misses.
 * Used by n8n tts-cache-warmer cron workflow.
 */
router.get('/cache-miss-report', (req, res) => {
  const limit = parseInt(req.query.limit || '30', 10);
  const phrases = getTopTtsCacheMisses({ limit });
  res.json({
    phrases,
    count: phrases.length,
    timestamp: new Date().toISOString()
  });
});

// ── Health ────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    pendingLlmTurns: getPendingTurnCount(),
    timestamp: new Date().toISOString()
  });
});

// ── On-demand smoke checks (curl-friendly) ────────────────────────────────

router.get('/smoke', async (_req, res) => {
  const nodeBase = validateNodeInternalBaseUrl();
  const webhookChecks = await runN8nStartupSmokeChecks();

  let nodeStatusProbe = null;
  let llmDoneProbe = null;

  if (nodeBase.normalized) {
    nodeStatusProbe = await requestJson({
      url: `${nodeBase.normalized}${CALLBACK_PATH_PREFIX}/status`
    });

    llmDoneProbe = await requestJson({
      url: `${nodeBase.normalized}${CALLBACK_PATH_PREFIX}/llm-done`,
      method: 'POST',
      body: { turnId: `smoke-${Date.now()}` }
    });
  }

  const webhookOk = webhookChecks.every((check) => check.ok);
  const nodeProbeOk = (!nodeStatusProbe || nodeStatusProbe.ok) && (!llmDoneProbe || llmDoneProbe.ok);

  res.json({
    ok: webhookOk && nodeProbeOk,
    nodeInternalBase: nodeBase,
    checks: {
      nodeInternalStatus: nodeStatusProbe,
      nodeInternalLlmDone: llmDoneProbe,
      webhooks: webhookChecks
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
