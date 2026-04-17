const test = require('node:test');
const assert = require('node:assert/strict');

const freshN8nLlmAdapter = () => {
  delete require.cache[require.resolve('../config/n8n')];
  delete require.cache[require.resolve('../services/ai/n8nLlmAdapter')];
  return require('../services/ai/n8nLlmAdapter');
};

test('n8n LLM adapter fails fast when webhook returns non-2xx', async () => {
  const oldEnv = {
    N8N_WEBHOOK_BASE_URL: process.env.N8N_WEBHOOK_BASE_URL,
    NODE_INTERNAL_BASE_URL: process.env.NODE_INTERNAL_BASE_URL,
    USE_N8N_LLM: process.env.USE_N8N_LLM,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL
  };
  const oldFetch = global.fetch;

  process.env.N8N_WEBHOOK_BASE_URL = 'https://n8n.example.com/webhook';
  process.env.NODE_INTERNAL_BASE_URL = 'https://api.example.com';
  process.env.USE_N8N_LLM = 'true';
  process.env.OPENAI_API_KEY = 'key';
  process.env.OPENAI_CHAT_MODEL = 'gpt-4o-mini';

  global.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'workflow unavailable'
  });

  try {
    const { streamChatCompletionViaN8n } = freshN8nLlmAdapter();

    await assert.rejects(
      () =>
        streamChatCompletionViaN8n({
          systemPrompt: 'test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          mode: 'chat',
          onDelta: () => {}
        }),
      /returned 503/
    );
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
