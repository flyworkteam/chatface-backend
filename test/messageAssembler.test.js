const test = require('node:test');
const assert = require('node:assert/strict');

test('SentenceAssembler emits an earlier first clause after first thresholds', () => {
  process.env.TTS_FIRST_CHUNK_MIN_CHARS = '28';
  process.env.TTS_FIRST_CHUNK_MIN_WORDS = '4';
  delete require.cache[require.resolve('../services/ai/messageAssembler')];
  const SentenceAssembler = require('../services/ai/messageAssembler');

  const chunks = [];
  const assembler = new SentenceAssembler({
    onSentenceComplete: (chunk) => chunks.push(chunk)
  });

  assembler.append('Okay, ');
  assert.deepEqual(chunks, []);

  assembler.append('I can help with that today, ');
  assert.deepEqual(chunks, ['Okay, I can help with that today,']);
});
