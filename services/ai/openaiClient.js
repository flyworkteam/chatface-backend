const OpenAI = require('openai');

const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_VOICE_MODEL = 'gpt-5.4-mini';
const DEFAULT_MODERATION_MODEL = 'omni-moderation-latest';
const DEFAULT_VOICE_REASONING_EFFORT = 'none';
const DEFAULT_VOICE_VERBOSITY = 'low';

let client;

const getOpenAIClient = () => {
  if (client) {
    return client;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  return client;
};

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const getChatModel = (mode = 'chat') =>
  isVoiceMode(mode) ? DEFAULT_VOICE_MODEL : DEFAULT_CHAT_MODEL;

const getVoiceReasoningEffort = () =>
  process.env.OPENAI_VOICE_REASONING_EFFORT || DEFAULT_VOICE_REASONING_EFFORT;

const getVoiceVerbosity = () =>
  process.env.OPENAI_VOICE_VERBOSITY || DEFAULT_VOICE_VERBOSITY;

const getModerationModel = () => DEFAULT_MODERATION_MODEL;

module.exports = {
  DEFAULT_CHAT_MODEL,
  DEFAULT_VOICE_MODEL,
  DEFAULT_MODERATION_MODEL,
  DEFAULT_VOICE_REASONING_EFFORT,
  DEFAULT_VOICE_VERBOSITY,
  getOpenAIClient,
  getChatModel,
  getVoiceReasoningEffort,
  getVoiceVerbosity,
  getModerationModel
};
