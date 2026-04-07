const { getOpenAIClient, getChatModel } = require('./openaiClient');

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

const toInputContent = (items = [], role = 'user') => {
  const content = [];
  const textType = role === 'assistant' ? 'output_text' : 'input_text';

  items.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    if (item.type === 'text') {
      content.push({
        type: textType,
        text: typeof item.text === 'string' ? item.text : ''
      });
      return;
    }

    if (role === 'assistant') {
      return;
    }

    if (item.type === 'image') {
      const mimeType = item.mimeType || 'image/jpeg';
      const imageUrl = item.inlineBase64
        ? `data:${mimeType};base64,${item.inlineBase64}`
        : item.url;

      if (!imageUrl) {
        return;
      }

      content.push({
        type: 'input_image',
        image_url: imageUrl,
        detail: 'auto'
      });
    }
  });

  if (!content.length) {
    content.push({
      type: textType,
      text: ''
    });
  }

  return content;
};

const approximatePromptTokens = (systemPrompt = '', messages = []) => {
  let charCount = typeof systemPrompt === 'string' ? systemPrompt.length : 0;

  messages.forEach((message) => {
    const items = Array.isArray(message?.content) ? message.content : [];
    items.forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }

      if (item.type === 'text' && typeof item.text === 'string') {
        charCount += item.text.length;
        return;
      }

      if (item.type === 'image') {
        charCount += typeof item.url === 'string' ? item.url.length : 0;
        charCount += typeof item.inlineBase64 === 'string' ? item.inlineBase64.length : 0;
      }
    });
  });

  return charCount > 0 ? Math.ceil(charCount / 4) : 0;
};

const extractOutputText = (response) => {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  if (!Array.isArray(response?.output)) {
    return '';
  }

  return response.output
    .filter((item) => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
};

const streamChatCompletion = async ({ systemPrompt, messages, onDelta, mode = 'chat' }) => {
  const client = getOpenAIClient();
  const generationConfig = isVoiceMode(mode) ? VOICE_GENERATION_CONFIG : CHAT_GENERATION_CONFIG;

  const stream = client.responses.stream({
    model: getChatModel(mode),
    instructions: systemPrompt,
    input: messages.map((message) => ({
      role: message.role,
      content: toInputContent(message.content, message.role)
    })),
    temperature: generationConfig.temperature,
    top_p: generationConfig.topP,
    max_output_tokens: generationConfig.maxOutputTokens
  });

  let fullText = '';

  stream.on('response.output_text.delta', (event) => {
    if (!event?.delta) {
      return;
    }

    fullText += event.delta;
    onDelta(event.delta);
  });

  const response = await stream.finalResponse();
  if (!fullText) {
    fullText = extractOutputText(response);
  }

  const usage = response?.usage || {};
  const fallbackPromptTokens = approximatePromptTokens(systemPrompt, messages);
  const fallbackResponseTokens = fullText ? Math.ceil(fullText.length / 4) : 0;

  return {
    fullText,
    tokensIn: usage.input_tokens ?? fallbackPromptTokens,
    tokensOut: usage.output_tokens ?? fallbackResponseTokens
  };
};

module.exports = {
  streamChatCompletion
};
