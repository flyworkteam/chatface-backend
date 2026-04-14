const test = require('node:test');
const assert = require('node:assert/strict');

const freshElevenLabs = () => {
  delete require.cache[require.resolve('../config/elevenlabs')];
  return require('../config/elevenlabs');
};

test('ElevenLabs payload uses language_code and pronunciation locators in precedence order', () => {
  const originalConfig = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARIES;
  process.env.ELEVENLABS_PRONUNCIATION_DICTIONARIES = JSON.stringify({
    default: [{ id: 'default-dict', version_id: 'v1' }],
    tr: [{ id: 'tr-dict', version_id: 'v2' }],
    'voice:voice-1': [{ id: 'voice-dict', version_id: 'v3' }],
    'voice:voice-1:tr': [{ id: 'voice-tr-dict', version_id: 'v4' }]
  });

  const { buildTtsPayload, resolvePronunciationDictionaryLocators } = freshElevenLabs();
  const locators = resolvePronunciationDictionaryLocators({
    voiceId: 'voice-1',
    language: 'tr'
  });

  assert.deepEqual(locators, [
    { pronunciation_dictionary_id: 'voice-tr-dict', version_id: 'v4' },
    { pronunciation_dictionary_id: 'voice-dict', version_id: 'v3' },
    { pronunciation_dictionary_id: 'tr-dict', version_id: 'v2' }
  ]);

  const payload = buildTtsPayload({
    voiceId: 'voice-1',
    text: 'Merhaba ChatFace.',
    language: 'tr'
  });

  assert.equal(payload.language_code, 'tr');
  assert.equal(payload.language, undefined);
  assert.deepEqual(payload.pronunciation_dictionary_locators, locators);

  if (originalConfig === undefined) delete process.env.ELEVENLABS_PRONUNCIATION_DICTIONARIES;
  else process.env.ELEVENLABS_PRONUNCIATION_DICTIONARIES = originalConfig;
});

test('ElevenLabs call payload uses hardcoded Flash without changing chat default', () => {
  const originalCallModel = process.env.ELEVENLABS_CALL_MODEL;
  const originalModel = process.env.ELEVENLABS_MODEL;
  const originalCallLatency = process.env.ELEVENLABS_CALL_STREAMING_LATENCY;
  const originalNormalization = process.env.ELEVENLABS_CALL_APPLY_TEXT_NORMALIZATION;

  process.env.ELEVENLABS_MODEL = 'ignored_model';
  process.env.ELEVENLABS_CALL_MODEL = 'ignored_call_model';
  process.env.ELEVENLABS_CALL_STREAMING_LATENCY = '1';
  process.env.ELEVENLABS_CALL_APPLY_TEXT_NORMALIZATION = 'on';

  const { buildTtsPayload, getTtsCacheContext } = freshElevenLabs();
  const callPayload = buildTtsPayload({
    voiceId: 'voice-1',
    text: 'Hi, how are you?',
    language: 'en',
    mode: 'video_call'
  });
  const chatPayload = buildTtsPayload({
    voiceId: 'voice-1',
    text: 'Hi, how are you?',
    language: 'en',
    mode: 'chat'
  });
  const callContext = getTtsCacheContext({
    voiceId: 'voice-1',
    language: 'en',
    mode: 'video_call'
  });
  const chatContext = getTtsCacheContext({
    voiceId: 'voice-1',
    language: 'en',
    mode: 'chat'
  });

  assert.equal(callPayload.model_id, 'eleven_flash_v2_5');
  assert.equal(callPayload.optimize_streaming_latency, 1);
  assert.equal(callPayload.apply_text_normalization, 'on');
  assert.equal(chatPayload.model_id, 'eleven_multilingual_v2');
  assert.equal(chatPayload.optimize_streaming_latency, 0);
  assert.equal(chatPayload.apply_text_normalization, undefined);
  assert.notDeepEqual(callContext, chatContext);

  if (originalCallModel === undefined) delete process.env.ELEVENLABS_CALL_MODEL;
  else process.env.ELEVENLABS_CALL_MODEL = originalCallModel;
  if (originalModel === undefined) delete process.env.ELEVENLABS_MODEL;
  else process.env.ELEVENLABS_MODEL = originalModel;
  if (originalCallLatency === undefined) delete process.env.ELEVENLABS_CALL_STREAMING_LATENCY;
  else process.env.ELEVENLABS_CALL_STREAMING_LATENCY = originalCallLatency;
  if (originalNormalization === undefined) delete process.env.ELEVENLABS_CALL_APPLY_TEXT_NORMALIZATION;
  else process.env.ELEVENLABS_CALL_APPLY_TEXT_NORMALIZATION = originalNormalization;
});
