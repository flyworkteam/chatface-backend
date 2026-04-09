const { enqueueSentence } = require('./ttsPipeline');
const { debug, warn } = require('./logger');

const THINKING_DELAY_MS = parseInt(process.env.THINKING_VOICE_DELAY_MS || '450', 10);

const THINKING_PHRASES = {
  en: ['Give me a second.', 'Let me think for a moment.', 'Good question.'],
  tr: ['Bir saniye.', 'Düşüneyim.', 'Güzel soru.', 'Hemen bakıyorum.'],
  es: ['Dame un segundo.', 'Déjame pensar.', 'Buena pregunta.'],
  fr: ['Une seconde.', 'Laisse-moi réfléchir.', 'Bonne question.'],
  de: ['Einen Moment.', 'Lass mich überlegen.', 'Gute Frage.'],
  pt: ['Um segundo.', 'Deixa eu pensar.', 'Boa pergunta.'],
  it: ['Un secondo.', 'Fammi pensare.', 'Bella domanda.'],
  ar: ['لحظة واحدة.', 'دعني أفكر.', 'سؤال جيد.'],
  ja: ['少し待ってください。', '少し考えます。', 'いい質問ですね。'],
  ko: ['잠시만요.', '생각해 볼게요.', '좋은 질문이네요.'],
  zh: ['稍等一下。', '让我想想。', '这是个好问题。'],
  ru: ['Секунду.', 'Дай подумать.', 'Хороший вопрос.']
};

const DEFAULT_PHRASES = THINKING_PHRASES.en;
const thinkingState = new Map();

const getRandomPhrase = (language) => {
  const phrases = THINKING_PHRASES[language] || DEFAULT_PHRASES;
  const index = Math.floor(Math.random() * phrases.length);
  return phrases[index];
};

const clearThinkingTimer = (sessionId) => {
  const current = thinkingState.get(sessionId);
  if (current?.timer) {
    clearTimeout(current.timer);
  }
};

const scheduleThinkingVoice = ({
  session,
  personaId,
  language,
  voiceConfig,
  sendEvent,
  userId
}) => {
  clearThinkingTimer(session.id);

  const playbackId = `thinking-${session.id}-${Date.now()}`;
  const phrase = getRandomPhrase(language);
  const controller = {
    cancelled: false
  };
  const timer = setTimeout(() => {
    const current = thinkingState.get(session.id);
    if (!current || current.playbackId !== playbackId || current.cancelled || controller.cancelled) {
      return;
    }

    current.started = true;
    const sequence = `thinking-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    debug('Playing thinking voice', {
      sessionId: session.id,
      language,
      phrase,
      playbackId
    });

    enqueueSentence({
      sessionId: session.id,
      personaId,
      language,
      text: phrase,
      variant: 'thinking',
      voiceConfig,
      sendEvent,
      userId,
      sequence,
      playbackId,
      shouldAbort: () => controller.cancelled
    }).catch((err) => warn('Thinking voice playback failed', err.message));
  }, THINKING_DELAY_MS);
  timer.unref?.();

  thinkingState.set(session.id, {
    timer,
    playbackId,
    controller,
    cancelled: false,
    started: false
  });

  return playbackId;
};

const cancelThinkingVoice = (sessionId, sendEvent) => {
  const current = thinkingState.get(sessionId);
  if (!current) {
    return;
  }

  clearThinkingTimer(sessionId);
  current.cancelled = true;
  if (current.controller) {
    current.controller.cancelled = true;
  }
  thinkingState.delete(sessionId);

  if (current.playbackId) {
    sendEvent('tts_suppressed', {
      reason: 'thinking_cancelled',
      playbackId: current.playbackId,
      sequence: current.playbackId
    });
  }
};

module.exports = {
  scheduleThinkingVoice,
  cancelThinkingVoice,
  getRandomPhrase,
  THINKING_PHRASES
};
