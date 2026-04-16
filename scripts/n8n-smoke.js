#!/usr/bin/env node

require('dotenv').config();

const {
  getWebhookUrl,
  isN8nConfigured,
  validateNodeInternalBaseUrl
} = require('../config/n8n');

const TIMEOUT_MS = parseInt(process.env.N8N_SMOKE_TIMEOUT_MS || '8000', 10);

const requestJson = async ({ url, method = 'GET', headers = {}, body = null }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
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
  } finally {
    clearTimeout(timeout);
  }
};

const printResult = (name, result) => {
  const status = result.error
    ? `ERR (${result.error})`
    : `${result.status}${result.ok ? ' OK' : ''}`;
  console.log(`[${name}] ${status}`);
  if (result.body) {
    console.log(`  body: ${result.body}`);
  }
};

const main = async () => {
  console.log('=== ChatFace n8n Smoke Test ===');

  const nodeBase = validateNodeInternalBaseUrl();
  console.log(`n8n configured: ${isN8nConfigured()}`);
  console.log(`node callback base valid: ${nodeBase.ok}`);
  if (nodeBase.issues.length) {
    console.log(`issues: ${nodeBase.issues.join(' | ')}`);
  }
  if (nodeBase.warnings.length) {
    console.log(`warnings: ${nodeBase.warnings.join(' | ')}`);
  }

  if (!isN8nConfigured()) {
    process.exitCode = 1;
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-n8n-secret': process.env.N8N_WEBHOOK_SECRET || ''
  };

  const checks = [];

  if (nodeBase.normalized) {
    checks.push({
      name: 'node-internal-status',
      task: requestJson({
        url: `${nodeBase.normalized}/api/ai/internal/status`
      })
    });
  }

  const aiChatUrl = getWebhookUrl('aiChat');
  checks.push({
    name: 'ai-chat-webhook',
    task: requestJson({
      url: aiChatUrl,
      method: 'POST',
      headers,
      body: {
        turnId: `smoke-${Date.now()}`,
        systemPrompt: 'You are a healthcheck responder.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        mode: 'chat',
        openAiKey: 'smoke-key',
        sentenceCallbackUrl: `${nodeBase.normalized || 'https://example.com'}/api/ai/internal/llm-sentence`,
        doneCallbackUrl: `${nodeBase.normalized || 'https://example.com'}/api/ai/internal/llm-done`,
        errorCallbackUrl: `${nodeBase.normalized || 'https://example.com'}/api/ai/internal/llm-error`
      }
    })
  });

  const analyticsUrl = getWebhookUrl('aiTurnAnalytics');
  checks.push({
    name: 'ai-turn-analytics-webhook',
    task: requestJson({
      url: analyticsUrl,
      method: 'POST',
      headers,
      body: {
        sessionId: 'smoke-session',
        userId: 'smoke-user',
        mode: 'chat',
        latencyMs: 100,
        llmIn: 1,
        llmOut: 1,
        ttsChars: 10,
        timestamp: new Date().toISOString()
      }
    })
  });

  const ttsVoiceId = process.env.N8N_SMOKE_TTS_VOICE_ID;
  if (ttsVoiceId && process.env.ELEVENLABS_API_KEY) {
    const ttsUrl = getWebhookUrl('ttsSynthesize');
    checks.push({
      name: 'tts-synthesize-contract',
      task: requestJson({
        url: ttsUrl,
        method: 'POST',
        headers,
        body: {
          voice_id: ttsVoiceId,
          text: process.env.N8N_SMOKE_TTS_TEXT || 'Hello from smoke test.',
          elevenLabsKey: process.env.ELEVENLABS_API_KEY,
          model_id: 'eleven_flash_v2_5',
          output_format: 'mp3_22050_32'
        }
      })
    });
  } else {
    console.log('[tts-synthesize-contract] SKIPPED (set N8N_SMOKE_TTS_VOICE_ID + ELEVENLABS_API_KEY)');
  }

  let hasFailures = false;
  for (const check of checks) {
    try {
      const result = await check.task;
      printResult(check.name, result);
      if (!result.ok) {
        hasFailures = true;
      }
      if (check.name === 'tts-synthesize-contract' && result.ok) {
        try {
          const parsed = JSON.parse(result.body || '{}');
          if (!parsed.audio) {
            hasFailures = true;
            console.log('  contract: missing `audio` field');
          }
        } catch (_err) {
          hasFailures = true;
          console.log('  contract: response is not valid JSON');
        }
      }
    } catch (error) {
      hasFailures = true;
      printResult(check.name, { error: error.message });
    }
  }

  if (hasFailures) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
