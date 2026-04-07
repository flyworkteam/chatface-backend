const { enqueueSentence } = require('./ttsPipeline');
const { debug, warn } = require('./logger');

/**
 * Thinking filler phrases per language.
 * Each persona will say these in their own ElevenLabs voice.
 */
const THINKING_PHRASES = {
  en: ['Hmm...', 'Let me think...', 'Good question...', 'Well...'],
  tr: ['Hmm...', 'Düşüneyim...', 'Güzel soru...', 'Şey...'],
  es: ['Hmm...', 'Déjame pensar...', 'Buena pregunta...', 'A ver...'],
  fr: ['Hmm...', 'Laisse-moi réfléchir...', 'Bonne question...', 'Voyons...'],
  de: ['Hmm...', 'Lass mich überlegen...', 'Gute Frage...', 'Also...'],
  pt: ['Hmm...', 'Deixa eu pensar...', 'Boa pergunta...', 'Então...'],
  it: ['Hmm...', 'Fammi pensare...', 'Bella domanda...', 'Vediamo...'],
  ar: ['همم...', 'دعني أفكر...', 'سؤال جيد...', 'حسناً...'],
  ja: ['えーっと...', 'そうですね...', 'いい質問ですね...', 'うーん...'],
  ko: ['음...', '생각해 볼게요...', '좋은 질문이네요...', '글쎄요...'],
  zh: ['嗯...', '让我想想...', '好问题...', '这个嘛...'],
  ru: ['Хмм...', 'Дай подумать...', 'Хороший вопрос...', 'Ну...']
};

const DEFAULT_PHRASES = THINKING_PHRASES.en;

const getRandomPhrase = (language) => {
  const phrases = THINKING_PHRASES[language] || DEFAULT_PHRASES;
  const index = Math.floor(Math.random() * phrases.length);
  return phrases[index];
};

/**
 * Play a thinking filler voice while the LLM is generating.
 * Uses the persona's ElevenLabs voice and TTS cache so repeated
 * phrases are served instantly on subsequent calls.
 */
const playThinkingVoice = async ({
  session,
  personaId,
  language,
  voiceConfig,
  sendEvent,
  userId
}) => {
  const phrase = getRandomPhrase(language);
  const thinkingPlaybackId = `thinking-${session.id}-${Date.now()}`;
  const sequence = `thinking-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  debug('Playing thinking voice', {
    sessionId: session.id,
    language,
    phrase,
    playbackId: thinkingPlaybackId
  });

  try {
    await enqueueSentence({
      sessionId: session.id,
      personaId,
      language,
      text: phrase,
      variant: 'thinking',
      voiceConfig,
      sendEvent,
      userId,
      sequence,
      playbackId: thinkingPlaybackId
    });
  } catch (err) {
    warn('Thinking voice playback failed', err.message);
  }
};

module.exports = {
  playThinkingVoice,
  getRandomPhrase,
  THINKING_PHRASES
};
