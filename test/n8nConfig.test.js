const test = require('node:test');
const assert = require('node:assert/strict');

const freshN8nConfig = () => {
  delete require.cache[require.resolve('../config/n8n')];
  return require('../config/n8n');
};

test('validateNodeInternalBaseUrl rejects https + :3000 when LLM routing is enabled', () => {
  const oldNodeInternal = process.env.NODE_INTERNAL_BASE_URL;
  const oldUseN8nLlm = process.env.USE_N8N_LLM;

  try {
    process.env.USE_N8N_LLM = 'true';
    process.env.NODE_INTERNAL_BASE_URL = 'https://example.ngrok-free.dev:3000';

    const { validateNodeInternalBaseUrl } = freshN8nConfig();
    const result = validateNodeInternalBaseUrl();

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((item) => item.includes('https://...:3000')));
  } finally {
    if (oldNodeInternal === undefined) delete process.env.NODE_INTERNAL_BASE_URL;
    else process.env.NODE_INTERNAL_BASE_URL = oldNodeInternal;
    if (oldUseN8nLlm === undefined) delete process.env.USE_N8N_LLM;
    else process.env.USE_N8N_LLM = oldUseN8nLlm;
  }
});

test('validateNodeInternalBaseUrl normalizes a valid callback host URL', () => {
  const oldNodeInternal = process.env.NODE_INTERNAL_BASE_URL;
  const oldUseN8nLlm = process.env.USE_N8N_LLM;

  try {
    process.env.USE_N8N_LLM = 'true';
    process.env.NODE_INTERNAL_BASE_URL = 'https://api.example.com/';

    const { validateNodeInternalBaseUrl } = freshN8nConfig();
    const result = validateNodeInternalBaseUrl();

    assert.equal(result.ok, true);
    assert.equal(result.normalized, 'https://api.example.com');
  } finally {
    if (oldNodeInternal === undefined) delete process.env.NODE_INTERNAL_BASE_URL;
    else process.env.NODE_INTERNAL_BASE_URL = oldNodeInternal;
    if (oldUseN8nLlm === undefined) delete process.env.USE_N8N_LLM;
    else process.env.USE_N8N_LLM = oldUseN8nLlm;
  }
});
