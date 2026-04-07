const { fetchRecentMessages, getPersonaById } = require('./memoryRepository');
const { getLanguageName } = require('./languageSupport');

const CHAT_CONTEXT_WINDOW = 40;
const VOICE_CONTEXT_WINDOW = 12;

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const buildSystemPrompt = (persona, summaries = [], conversationLanguage) => {
  const summaryBlock = summaries.length
    ? `\nConversation summaries:\n${summaries.map((s) => `- ${s.summary}`).join('\n')}`
    : '';

  const ttsSafetyBlock = `\nOutput rules for speech synthesis:\n- Do not use emojis, emoticons, or decorative symbols.\n- Use plain readable text with standard punctuation.\n- Avoid markdown formatting, lists with special bullets, and unusual characters.\n- Keep responses natural and easy to read out loud.`;
  const languageBlock = `\nLanguage rules:\n- Reply in ${getLanguageName(conversationLanguage)}.\n- Match the user's latest accepted language for this session.\n- If the user input is ambiguous, stay in the current conversation language.`;

  return `${persona.prompt_template}${ttsSafetyBlock}${languageBlock}\n${summaryBlock}`.trim();
};

const ATTACHMENT_INLINE_LIMIT = 350 * 1024; // 350KB safeguard

const toContentItems = (content = {}) => {
  const items = [];
  const text = typeof content.text === 'string' ? content.text.trim() : '';

  if (text) {
    items.push({ type: 'text', text });
  }

  const attachments = Array.isArray(content.attachments) ? content.attachments : [];
  attachments.forEach((attachment) => {
    const inline = attachment?.inlineBase64;
    if (inline && inline.length * 0.75 <= ATTACHMENT_INLINE_LIMIT) {
      items.push({
        type: 'image',
        mimeType: attachment.mimeType || 'image/jpeg',
        inlineBase64: inline
      });
      return;
    }

    if (typeof attachment?.url === 'string' && attachment.url.trim()) {
      items.push({
        type: 'image',
        mimeType: attachment.mimeType || 'image/jpeg',
        url: attachment.url.trim()
      });
    }
  });

  if (!items.length) {
    items.push({ type: 'text', text: '' });
  }

  return items;
};

const normalizeRole = (role) => {
  if (role === 'assistant') {
    return 'assistant';
  }
  return 'user';
};

const buildContext = async ({ sessionId, personaId, summaries = [], mode = 'chat', conversationLanguage }) => {
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
    content: toContentItems(message.content)
  }));

  return {
    systemPrompt: buildSystemPrompt(persona, summaries, conversationLanguage),
    messages: formattedMessages,
    persona
  };
};

module.exports = {
  buildContext
};
