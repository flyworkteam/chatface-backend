const test = require('node:test');
const assert = require('node:assert/strict');

const freshOpenAiAdapter = () => {
  delete require.cache[require.resolve('../services/ai/openaiClient')];
  delete require.cache[require.resolve('../services/ai/openaiAdapter')];
  return require('../services/ai/openaiAdapter');
};

test('voice response request uses fast GPT-5.4 defaults', () => {
  const originalVoiceModel = process.env.OPENAI_VOICE_MODEL;
  const originalChatModel = process.env.OPENAI_CHAT_MODEL;
  const originalReasoning = process.env.OPENAI_VOICE_REASONING_EFFORT;
  const originalVerbosity = process.env.OPENAI_VOICE_VERBOSITY;
  process.env.OPENAI_VOICE_MODEL = 'ignored-voice-model';
  process.env.OPENAI_CHAT_MODEL = 'ignored-chat-model';
  delete process.env.OPENAI_VOICE_REASONING_EFFORT;
  delete process.env.OPENAI_VOICE_VERBOSITY;

  const { buildResponseStreamRequest } = freshOpenAiAdapter();
  const request = buildResponseStreamRequest({
    systemPrompt: 'You are helpful.',
    mode: 'voice_call',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]
  });

  assert.equal(request.model, 'gpt-5.4-mini');
  assert.deepEqual(request.reasoning, { effort: 'none' });
  assert.deepEqual(request.text, { verbosity: 'low' });
  assert.equal(request.temperature, undefined);
  assert.equal(request.top_p, undefined);

  const chatRequest = buildResponseStreamRequest({
    systemPrompt: 'You are helpful.',
    mode: 'chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]
  });
  assert.equal(chatRequest.model, 'gpt-4o-mini');

  if (originalVoiceModel === undefined) delete process.env.OPENAI_VOICE_MODEL;
  else process.env.OPENAI_VOICE_MODEL = originalVoiceModel;
  if (originalChatModel === undefined) delete process.env.OPENAI_CHAT_MODEL;
  else process.env.OPENAI_CHAT_MODEL = originalChatModel;
  if (originalReasoning === undefined) delete process.env.OPENAI_VOICE_REASONING_EFFORT;
  else process.env.OPENAI_VOICE_REASONING_EFFORT = originalReasoning;
  if (originalVerbosity === undefined) delete process.env.OPENAI_VOICE_VERBOSITY;
  else process.env.OPENAI_VOICE_VERBOSITY = originalVerbosity;
});
