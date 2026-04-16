const { enqueueSentence } = require('./ttsPipeline');
const { debug, warn } = require('./logger');

// Varsayılan: 450ms → 350ms. AI yanıtı işlenmeden önce kullanıcıya hızlıca geri bildirim
// verilmesi için süre kısaltıldı. Karakter "Bir saniye." gibi bir dolgu cümlesi çalar,
// böylece kullanıcı konuşmayı 2-3 kez tekrarlamak zorunda kalmaz.
const THINKING_DELAY_MS = parseInt(process.env.THINKING_VOICE_DELAY_MS || '350', 10);

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

// ─── STT Reddi Filler Sesleri ─────────────────────────────────────────────────

// Kullanıcı anlaşılamadığında (düşük güven, çok kısa, vs.) çalan sözler
const CANNOT_UNDERSTAND_PHRASES = {
  en: ["Sorry, I didn't catch that. Could you say it again?", "I didn't quite hear you, could you repeat that?", "I couldn't understand, please try again."],
  tr: ['Anlayamadım, tekrar söyler misin?', 'Seni duyamadım, bir daha söyler misin?', 'Tam anlayamadım, tekrar eder misin?'],
  es: ['No te entendí, ¿puedes repetirlo?', 'No te escuché bien, ¿lo puedes decir otra vez?'],
  fr: ["Je n'ai pas compris, tu peux répéter?", "Je n'ai pas bien entendu, peux-tu répéter?"],
  de: ['Ich habe dich nicht verstanden. Kannst du das wiederholen?', 'Das habe ich nicht gehört. Bitte noch einmal.'],
  pt: ['Não entendi, pode repetir?', 'Não ouvi direito, pode falar de novo?'],
  it: ['Non ho capito, puoi ripetere?', 'Non ti ho sentito bene, puoi ripetere?'],
  ja: ['聞き取れませんでした。もう一度言ってもらえますか？', 'すみません、もう一度お願いします。'],
  ko: ['잘 못 들었어요, 다시 말해줄 수 있어요?', '이해하지 못했어요, 다시 한번 말해줄래요?'],
  zh: ['我没听清楚，你能再说一遍吗？', '没听懂，请再说一次。'],
  ru: ['Я не расслышал. Можешь повторить?', 'Не понял, повтори пожалуйста.'],
  hi: ['मैं समझ नहीं पाया, क्या आप दोबारा कह सकते हैं?', 'सुन नहीं पाया, फिर से बोलें।'],
  ar: ['لم أفهم، هل يمكنك الإعادة؟', 'لم أسمعك جيداً، أعد من فضلك.']
};

// Kullanıcı yanlış/desteklenmeyen dilde konuştuğunda çalan sözler
const WRONG_LANGUAGE_PHRASES = {
  en: ["I can only speak in the selected language right now. Please change your language setting.", "I'm not able to chat in that language at the moment. Try switching languages."],
  tr: ['Şu an bu dilde konuşamıyorum, dil ayarını değiştirmelisin.', 'Bu dilde cevap veremiyorum, lütfen dilini değiştir.', 'Sadece seçili dilde konuşabiliyorum, dili değiştirmelisin.'],
  es: ['Ahora mismo solo puedo hablar en el idioma seleccionado. Por favor, cambia el idioma.', 'No puedo chatear en ese idioma, intenta cambiar el idioma.'],
  fr: ["Je ne peux parler qu'en la langue sélectionnée pour l'instant. Change la langue.", "Je ne peux pas chatter dans cette langue, essaie de changer la langue."],
  de: ['Ich kann gerade nur in der ausgewählten Sprache sprechen. Bitte ändere die Sprache.', 'In dieser Sprache kann ich gerade nicht antworten. Wechsle bitte die Sprache.'],
  pt: ['Agora só posso falar no idioma selecionado. Muda o idioma.', 'Não consigo responder nesse idioma agora, tente mudar o idioma.'],
  it: ['In questo momento posso parlare solo nella lingua selezionata. Cambia la lingua.', 'Non riesco a rispondere in questa lingua, prova a cambiare la lingua.'],
  ja: ['今は選択した言語でしか話せません。言語を変更してください。', 'その言語では話せません。言語を切り替えてみてください。'],
  ko: ['지금은 선택된 언어로만 말할 수 있어요. 언어를 변경해 주세요.', '그 언어로는 대화할 수 없어요, 언어를 바꿔보세요.'],
  zh: ['我现在只能用所选语言交流，请切换语言。', '我无法用那种语言聊天，试试切换语言吧。'],
  ru: ['Сейчас я могу говорить только на выбранном языке. Смени язык.', 'На этом языке я не могу общаться, попробуй сменить язык.'],
  hi: ['मैं अभी केवल चयनित भाषा में बोल सकता हूं। भाषा बदलें।', 'उस भाषा में बात नहीं कर सकता, भाषा बदलने की कोशिश करें।'],
  ar: ['يمكنني التحدث فقط باللغة المحددة الآن. غيّر اللغة.', 'لا أستطيع الدردشة بهذه اللغة، جرّب تغيير اللغة.']
};

const getRandomRejectionPhrase = (phrases, language) => {
  const list = phrases[language] || phrases.en;
  return list[Math.floor(Math.random() * list.length)];
};

/**
 * STT transkripti reddedildiğinde sesli geri bildirim çal.
 * - 'wrong_language': Kullanıcı oturum diline uymayan bir dilde konuştu
 * - diğer sebepler: Anlaşılamadı (düşük güven, çok kısa, vs.)
 *
 * @param {{ session, personaId, language, voiceConfig, sendEvent, userId, reason }} opts
 */
const playRejectionVoice = ({ session, personaId, language, voiceConfig, sendEvent, userId, reason }) => {
  if (!voiceConfig) return;

  const isWrongLang = reason === 'locked_language_mismatch';
  const phraseMap = isWrongLang ? WRONG_LANGUAGE_PHRASES : CANNOT_UNDERSTAND_PHRASES;
  const text = getRandomRejectionPhrase(phraseMap, language);
  const playbackId = `rejection-${session.id}-${Date.now()}`;
  const sequence = `${playbackId}-${Math.random().toString(36).slice(2, 6)}`;

  debug('Playing rejection voice', {
    sessionId: session.id,
    reason,
    language,
    text,
    playbackId
  });

  enqueueSentence({
    sessionId: session.id,
    personaId,
    language,
    text,
    variant: 'thinking', // thinking variant'ı: TTS cache'e kaydedilmez
    voiceConfig,
    sendEvent,
    userId,
    sequence,
    playbackId,
    shouldAbort: () => false
  }).catch((err) => warn('Rejection voice playback failed', err.message));
};

module.exports = {
  scheduleThinkingVoice,
  cancelThinkingVoice,
  getRandomPhrase,
  playRejectionVoice,
  THINKING_PHRASES,
  CANNOT_UNDERSTAND_PHRASES,
  WRONG_LANGUAGE_PHRASES
};
