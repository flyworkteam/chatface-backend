const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCacheKey } = require('../services/ai/ttsCacheService');

test('TTS cache key changes when model or pronunciation locator changes', () => {
  const base = buildCacheKey('persona-1', 'en', 'Hello there.', 'default', {
    modelId: 'eleven_multilingual_v2',
    pronunciationDictionaries: [
      { pronunciation_dictionary_id: 'dict-1', version_id: 'v1' }
    ]
  });
  const changedModel = buildCacheKey('persona-1', 'en', 'Hello there.', 'default', {
    modelId: 'eleven_flash_v2_5',
    pronunciationDictionaries: [
      { pronunciation_dictionary_id: 'dict-1', version_id: 'v1' }
    ]
  });
  const changedDictionary = buildCacheKey('persona-1', 'en', 'Hello there.', 'default', {
    modelId: 'eleven_multilingual_v2',
    pronunciationDictionaries: [
      { pronunciation_dictionary_id: 'dict-1', version_id: 'v2' }
    ]
  });

  assert.notEqual(base, changedModel);
  assert.notEqual(base, changedDictionary);
});

test('TTS cache key changes between call Flash and chat Multilingual contexts', () => {
  const chat = buildCacheKey('persona-1', 'en', 'Hello there.', 'default', {
    modelId: 'eleven_multilingual_v2',
    optimizeStreamingLatency: 0,
    outputFormat: 'mp3_22050_32'
  });
  const call = buildCacheKey('persona-1', 'en', 'Hello there.', 'default', {
    modelId: 'eleven_flash_v2_5',
    optimizeStreamingLatency: 0,
    outputFormat: 'mp3_22050_32'
  });

  assert.notEqual(chat, call);
});
