const { GoogleGenerativeAI } = require('@google/generative-ai');
const { warn } = require('./logger');

let client;
const models = new Map();

const VOICE_MODEL = process.env.GEMINI_VOICE_MODEL || 'gemini-2.5-flash-lite';
const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const VOICE_GENERATION_CONFIG = {
  temperature: 0.7,
  topP: 0.9,
  maxOutputTokens: 256
};

const CHAT_GENERATION_CONFIG = {
  temperature: 0.7,
  topP: 0.9
};

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const getClient = () => {
  if (client) {
    return client;
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
};

const getModel = (mode) => {
  const modelName = isVoiceMode(mode) ? VOICE_MODEL : CHAT_MODEL;
  if (models.has(modelName)) {
    return models.get(modelName);
  }
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: modelName });
  models.set(modelName, model);
  return model;
};

const streamChatCompletion = async ({ systemPrompt, messages, onDelta, mode = 'chat' }) => {
  const model = getModel(mode);
  const generationConfig = isVoiceMode(mode) ? VOICE_GENERATION_CONFIG : CHAT_GENERATION_CONFIG;

  const streamResult = await model.generateContentStream({
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: messages,
    generationConfig
  });

  let fullText = '';
  for await (const item of streamResult.stream) {
    const chunkText = item.text();
    if (!chunkText) {
      continue;
    }
    fullText += chunkText;
    onDelta(chunkText);
  }

  const response = await streamResult.response;
  const usage = response?.usageMetadata || {};

  const approxPromptChars = messages.reduce((sum, message) => {
    if (!Array.isArray(message.parts)) {
      return sum;
    }
    const textParts = message.parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    return sum + textParts.length;
  }, systemPrompt?.length || 0);

  const fallbackPromptTokens = approxPromptChars > 0
    ? Math.ceil(approxPromptChars / 4)
    : 0;
  const fallbackResponseTokens = fullText ? Math.ceil(fullText.length / 4) : 0;

  return {
    fullText,
    tokensIn: usage.promptTokenCount ?? fallbackPromptTokens,
    tokensOut: usage.candidatesTokenCount ?? fallbackResponseTokens
  };
};

module.exports = {
  streamChatCompletion
};
