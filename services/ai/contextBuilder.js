const { fetchRecentMessages, fetchMessagesAfterId, getLatestMemorySummary, getPersonaById, getMemoryEntries, getUserById } = require('./memoryRepository');
const { getLanguageName } = require('./languageSupport');
const { debug, warn } = require('./logger');
const { getWebhookUrl, isN8nConfigured } = require('../../config/n8n');

const CHAT_CONTEXT_WINDOW = 40;
const VOICE_CONTEXT_WINDOW = 12;
const USE_N8N_PERSONA_CONFIG = process.env.USE_N8N_PERSONA_CONFIG === 'true';
const PERSONA_PROMPT_CACHE_MS = parseInt(process.env.PERSONA_PROMPT_CACHE_MS || '300000', 10);
const personaPromptCache = new Map();

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const buildSystemPrompt = (persona, summaries = [], memoryEntries = [], conversationLanguage, mode = 'chat', user = null) => {
  const summaryBlock = summaries.length
    ? `\nConversation context (from earlier in this session):\n${summaries.map((s) => `- ${s.summary}`).join('\n')}`
    : '';

  const entriesBlock = memoryEntries.length
    ? `\nUser details & preferences (permanent memory):\n${memoryEntries.map((e) => {
      if (typeof e.value === 'string') return `- ${e.value}`;
      if (e.value && e.value.fact) return `- ${e.value.fact}`;
      return `- ${JSON.stringify(e.value)}`;
    }).join('\n')}`
    : '';

  const userContextBlock = user
    ? `\nUser information:
- Name: ${user.fullName || 'Not provided'}
- Age: ${user.age || 'Not provided'}
- Gender: ${user.gender || 'Not provided'}
- Location: ${user.country || 'Not provided'}
- About: ${user.aboutMe || 'No bio provided'}
(Use this information to personalize your responses, but do not mention that you know it came from the user's profile.)`
    : '';

  // TTS safety: LLM must never produce symbols that break speech synthesis
  const ttsSafetyBlock = `\nSpeech output rules (critical — your reply will be spoken aloud):
- Write in plain, natural spoken sentences. No emojis, emoticons, or decorative symbols.
- No markdown: no asterisks, no bullet points, no headers, no code blocks.
- Spell out abbreviations the first time (e.g. "by the way" not "btw").
- Use commas and natural pauses instead of dashes or parentheses.
- Numbers: say "twenty five" not "25" when it reads more naturally aloud.`;

  // Sesli/görüntülü aramada dil kilitlenir (STT doğrulama zaten mecbur tutuyor).
  // Yazılı chat'te ise kullanıcı hangi dilde yazarsa o dilde cevap ver;
  // bu sayede önceki konuşmadan bağımsız olarak dil değişebilir.
  const languageBlock = isVoiceMode(mode)
    ? `\nLanguage rules:
- Always reply in ${getLanguageName(conversationLanguage)}.
- Stay strictly in ${getLanguageName(conversationLanguage)} for the entire conversation; do not switch languages even if the user tries.`
    : `\nLanguage rules:
- Detect the language the user is writing in and reply in that same language.
- If the user writes in Turkish, respond entirely in Turkish. If they write in English, respond in English. Follow whatever language they use in each message.
- Do not default to a fixed language; always mirror the user's current language.`;

  return `${persona.prompt_template}${userContextBlock}${ttsSafetyBlock}${languageBlock}\n${entriesBlock}\n${summaryBlock}`.trim();
};

const buildVoicePromptSuffix = (mode) => {
  const modeLabel = mode === 'video_call' ? 'video chat' : 'voice chat';

  return `\nCurrent interaction mode: ${modeLabel}
- You are speaking with the user in a ${modeLabel}, not reading a text chat.
- Never say or imply that you can read the user's writing, messages, or text input in this mode.
- If you refer to the user's input, describe it as something you heard or understood.
- Keep each reply short and conversational — typically one to three sentences.
- Lead with your most important thought in the very first sentence so it can be spoken immediately.
- Avoid listing things; weave information naturally into speech.
- Match the user's energy and pace: if they're brief, be brief; if they elaborate, you can too.
- Never start with filler phrases like "Certainly!" or "Of course!" — just respond naturally.`;
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

const buildPersonaPromptCacheKey = (personaId) => String(personaId || '');

const getCachedPersonaPrompt = (personaId) => {
  const key = buildPersonaPromptCacheKey(personaId);
  const cached = personaPromptCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt > Date.now()) {
    return cached.prompt;
  }
  return null;
};

const setCachedPersonaPrompt = (personaId, prompt, ttlMs = PERSONA_PROMPT_CACHE_MS) => {
  const key = buildPersonaPromptCacheKey(personaId);
  personaPromptCache.set(key, {
    prompt,
    expiresAt: Date.now() + Math.max(1000, ttlMs)
  });
};

const getAnyCachedPersonaPrompt = (personaId) => {
  const key = buildPersonaPromptCacheKey(personaId);
  return personaPromptCache.get(key)?.prompt || null;
};

const resolvePromptFromPayload = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidates = [
    payload.systemPrompt,
    payload.promptTemplate,
    payload.prompt,
    payload?.data?.systemPrompt,
    payload?.data?.promptTemplate,
    payload?.data?.prompt
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
};

const fetchPersonaPromptTemplateViaN8n = async (personaId, fallbackPromptTemplate) => {
  if (!USE_N8N_PERSONA_CONFIG || !isN8nConfigured()) {
    return fallbackPromptTemplate;
  }

  const hotCache = getCachedPersonaPrompt(personaId);
  if (hotCache) {
    return hotCache;
  }

  const baseWebhookUrl = getWebhookUrl('personaConfig');
  if (!baseWebhookUrl) {
    return fallbackPromptTemplate;
  }

  const webhookUrl = `${baseWebhookUrl}/${encodeURIComponent(String(personaId))}`;

  try {
    const response = await fetch(webhookUrl, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    const payload = await response.json();
    const promptTemplate = resolvePromptFromPayload(payload);
    if (!promptTemplate) {
      throw new Error('Missing systemPrompt/promptTemplate in persona-config response');
    }

    setCachedPersonaPrompt(personaId, promptTemplate);
    return promptTemplate;
  } catch (error) {
    const stalePrompt = getAnyCachedPersonaPrompt(personaId);
    if (stalePrompt) {
      warn('Persona prompt fetch failed; using stale cached prompt', error.message);
      return stalePrompt;
    }
    debug('Persona prompt fetch failed; using DB prompt template', error.message);
    return fallbackPromptTemplate;
  }
};

const buildContext = async ({
  sessionId,
  userId,
  personaId,
  summaries = [], // still accepted but we will supplement with DB summary
  mode = 'chat',
  conversationLanguage,
  lockedLanguage = null,
  pendingMessages = []
}) => {
  const contextLimit = isVoiceMode(mode) ? VOICE_CONTEXT_WINDOW : CHAT_CONTEXT_WINDOW;

  const [persona, latestSummary, longTermEntries, user] = await Promise.all([
    getPersonaById(personaId),
    getLatestMemorySummary(sessionId),
    userId ? getMemoryEntries(userId, 'long_term', 'en') : Promise.resolve([]),
    userId ? getUserById(userId) : Promise.resolve(null)
  ]);

  if (!persona) {
    throw new Error('Persona not found or inactive');
  }

  const messages = latestSummary && latestSummary.last_message_id
    ? await fetchMessagesAfterId(sessionId, latestSummary.last_message_id, contextLimit)
    : await fetchRecentMessages(sessionId, contextLimit);

  const dbSummaries = latestSummary ? [{ summary: latestSummary.summary }] : [];
  const mergedSummaries = [...dbSummaries, ...summaries];

  const promptTemplate = await fetchPersonaPromptTemplateViaN8n(
    persona.id,
    persona.prompt_template
  );

  // Voice/video call: use lockedLanguage as the authoritative signal so
  // the LLM prompt lines up with what STT is transcribing. If no lock is
  // set (unexpected during a call, but safe), fall back to the per-turn
  // conversationLanguage. Chat mode always uses conversationLanguage so
  // auto-detection can switch mid-session.
  const effectiveLanguage = isVoiceMode(mode)
    ? (lockedLanguage || conversationLanguage)
    : conversationLanguage;

  const formattedMessages = messages.map((message) => ({
    role: normalizeRole(message.role),
    content: toContentItems(message.content)
  }));
  const inMemoryMessages = Array.isArray(pendingMessages)
    ? pendingMessages.map((message) => ({
      role: normalizeRole(message.role),
      content: toContentItems(message.content)
    }))
    : [];

  return {
    systemPrompt: `${buildSystemPrompt({ ...persona, prompt_template: promptTemplate }, mergedSummaries, longTermEntries, effectiveLanguage, mode, user)}${isVoiceMode(mode) ? buildVoicePromptSuffix(mode) : ''}`.trim(),
    messages: [...formattedMessages, ...inMemoryMessages],
    persona,
    user,
    effectiveLanguage
  };
};

module.exports = {
  buildContext
};
