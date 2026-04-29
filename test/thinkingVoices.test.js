const test = require('node:test');
const assert = require('node:assert/strict');

const { getGatewayErrorHint, GATEWAY_HINT_PHRASES } = require('../services/ai/thinkingVoices');

test('getGatewayErrorHint returns localized moderation hint for Turkish', () => {
  const hint = getGatewayErrorHint({ code: 'moderation', language: 'tr' });
  assert.ok(typeof hint === 'string' && hint.length > 0);
  assert.ok(GATEWAY_HINT_PHRASES.moderation.tr.includes(hint));
});

test('getGatewayErrorHint maps pipeline errors to reconnect hint family', () => {
  const hint = getGatewayErrorHint({ code: 'llm_error', language: 'hi' });
  assert.ok(typeof hint === 'string' && hint.length > 0);
  assert.ok(GATEWAY_HINT_PHRASES.connection_retry_exhausted.hi.includes(hint));
});

test('getGatewayErrorHint falls back to English for unsupported language code', () => {
  const hint = getGatewayErrorHint({ code: 'moderation', language: 'ar' });
  assert.ok(typeof hint === 'string' && hint.length > 0);
  assert.ok(GATEWAY_HINT_PHRASES.moderation.en.includes(hint));
});
