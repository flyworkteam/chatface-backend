const { fetchRecentMessages, getPersonaById } = require('./memoryRepository');

const CHAT_CONTEXT_WINDOW = 40;
const VOICE_CONTEXT_WINDOW = 12;

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const buildSystemPrompt = (persona, summaries = []) => {
  const summaryBlock = summaries.length
    ? `\nConversation summaries:\n${summaries.map((s) => `- ${s.summary}`).join('\n')}`
    : '';

  const ttsSafetyBlock = `\nOutput rules for speech synthesis:\n- Do not use emojis, emoticons, or decorative symbols.\n- Use plain readable text with standard punctuation.\n- Avoid markdown formatting, lists with special bullets, and unusual characters.\n- Keep responses natural and easy to read out loud.`;

  return `${persona.prompt_template}${ttsSafetyBlock}\n${summaryBlock}`.trim();
};

const ATTACHMENT_INLINE_LIMIT = 350 * 1024; // 350KB safeguard

const toParts = (content = {}) => {
  const parts = [];
  const text = typeof content.text === 'string' ? content.text.trim() : '';

  if (text) {
    parts.push({ text });
  }

  const attachments = Array.isArray(content.attachments) ? content.attachments : [];
  attachments.forEach((attachment) => {
    const inline = attachment?.inlineBase64;
    if (inline && inline.length * 0.75 <= ATTACHMENT_INLINE_LIMIT) {
      parts.push({
        inlineData: {
          mimeType: attachment.mimeType || 'image/jpeg',
          data: inline
        }
      });
    }
  });

  if (!parts.length) {
    parts.push({ text: '' });
  }

  return parts;
};

const normalizeRole = (role) => {
  if (role === 'assistant') {
    return 'model';
  }
  return 'user';
};

const buildContext = async ({ sessionId, personaId, summaries = [], mode = 'chat' }) => {
  const contextLimit = isVoiceMode(mode) ? VOICE_CONTEXT_WINDOW : CHAT_CONTEXT_WINDOW;

  const [persona, messages] = await Promise.all([
    getPersonaById(personaId),
    fetchRecentMessages(sessionId, contextLimit)
  ]);

  if (!persona) {
    throw new Error('Persona not found or inactive');
  }

  const formattedMessages = messages.map((message) => ({
    role: normalizeRole(message.role),
    parts: toParts(message.content)
  }));

  return {
    systemPrompt: buildSystemPrompt(persona, summaries),
    messages: formattedMessages,
    persona
  };
};

module.exports = {
  buildContext
};
