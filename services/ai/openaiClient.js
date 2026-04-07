const OpenAI = require('openai');

const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_VOICE_MODEL = 'gpt-4o-mini';
const DEFAULT_MODERATION_MODEL = 'omni-moderation-latest';

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
  isVoiceMode(mode)
    ? process.env.OPENAI_VOICE_MODEL || DEFAULT_VOICE_MODEL
    : process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL;

const getModerationModel = () =>
  process.env.OPENAI_MODERATION_MODEL || DEFAULT_MODERATION_MODEL;

module.exports = {
  DEFAULT_CHAT_MODEL,
  DEFAULT_VOICE_MODEL,
  DEFAULT_MODERATION_MODEL,
  getOpenAIClient,
  getChatModel,
  getModerationModel
};
