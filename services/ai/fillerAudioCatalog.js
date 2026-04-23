/**
 * fillerAudioCatalog.js
 *
 * The canonical list of filler / placeholder phrases used while the user waits,
 * or when we need to gracefully reject a turn without routing to the LLM.
 *
 * Languages covered: en, tr, de, it, fr, ja, es, ru, ko, hi, pt, zh.
 * Scenarios: thinking_short, thinking_long, cant_understand, wrong_language,
 *            network_hiccup, cold_start.
 *
 * The n8n `filler-audio` workflow iterates persona × language × scenario and
 * pre-renders audio to BunnyCDN at persona create / update. At runtime we
 * serve directly from the cache — no synthesis in the hot path.
 *
 * See REWRITE_ARCHITECTURE.md §8.
 */

const CATALOG = {
  en: {
    thinking_short: ['Hmm…', 'One sec.', 'Let me see.'],
    thinking_long: [
      'Let me think about that for a moment.',
      'Give me a sec to put this together.',
      'Hmm, let me work through that.',
    ],
    cant_understand: [
      "Sorry, I didn't catch that.",
      'Could you say that again?',
      'Say that one more time?',
    ],
    wrong_language: [
      "Can we stay in English for this one?",
      "Let's keep it in English, okay?",
      "I'll stick to English for now.",
    ],
    network_hiccup: [
      "Hold on, my connection's being weird.",
      "One sec — something glitched on my end.",
      'Bear with me for a moment.',
    ],
    cold_start: [
      'Hey! Give me a second to get settled.',
      'Hi there, just a moment.',
      "I'm here — one sec.",
    ],
  },
  tr: {
    thinking_short: ['Hmm…', 'Bir saniye.', 'Dur bakayım.'],
    thinking_long: [
      'Bir saniye düşüneyim.',
      'Dur, bunu bir toparlayayım.',
      'Hmm, bir düşünmem lazım.',
    ],
    cant_understand: [
      'Pardon, seni duyamadım.',
      'Tekrar söyler misin?',
      'Bir daha söyler misin?',
    ],
    wrong_language: [
      'Türkçe konuşsak olur mu?',
      'Bu sohbeti Türkçe yürütelim.',
      'Türkçeden devam edelim.',
    ],
    network_hiccup: [
      'Bir saniye, bağlantım dalgalanıyor.',
      'Dur, bir şeyler takıldı.',
      'Bir saniye müsaade et.',
    ],
    cold_start: [
      'Selam! Bir saniye hazırlanayım.',
      'Merhaba, bir saniye.',
      'Buradayım, bir saniye.',
    ],
  },
  de: {
    thinking_short: ['Hmm…', 'Moment.', 'Lass mich sehen.'],
    thinking_long: [
      'Lass mich kurz nachdenken.',
      'Einen Moment, ich sortiere das.',
      'Hmm, das muss ich einmal durchgehen.',
    ],
    cant_understand: [
      'Entschuldige, das habe ich nicht verstanden.',
      'Kannst du das noch einmal sagen?',
      'Sag das bitte nochmal.',
    ],
    wrong_language: [
      'Bleiben wir bei Deutsch, okay?',
      'Lass uns auf Deutsch weiterreden.',
    ],
    network_hiccup: [
      'Moment, meine Verbindung wackelt.',
      'Einen Augenblick bitte.',
    ],
    cold_start: [
      'Hey! Eine Sekunde, ich komme zu Wort.',
      'Hallo, einen Moment.',
    ],
  },
  it: {
    thinking_short: ['Mmm…', 'Un attimo.', "Fammi pensare."],
    thinking_long: [
      "Fammi riflettere un attimo.",
      'Dammi un secondo per mettere insieme le idee.',
    ],
    cant_understand: [
      'Scusa, non ho capito.',
      'Puoi ripetere?',
    ],
    wrong_language: [
      "Parliamo in italiano, va bene?",
      "Continuiamo in italiano.",
    ],
    network_hiccup: [
      "Un attimo, la mia connessione sta facendo scherzi.",
      'Abbi pazienza un secondo.',
    ],
    cold_start: [
      'Ciao! Un attimo che mi preparo.',
      'Ehi, un secondo.',
    ],
  },
  fr: {
    thinking_short: ['Hmm…', 'Un instant.', 'Voyons voir.'],
    thinking_long: [
      'Laisse-moi réfléchir un instant.',
      'Donne-moi une seconde pour y réfléchir.',
    ],
    cant_understand: [
      "Désolé, je n'ai pas compris.",
      'Tu peux répéter ?',
    ],
    wrong_language: [
      'On continue en français ?',
      'Restons en français.',
    ],
    network_hiccup: [
      'Un instant, ma connexion fait des siennes.',
      'Patiente une seconde.',
    ],
    cold_start: [
      'Salut ! Une seconde, je me prépare.',
      'Coucou, un instant.',
    ],
  },
  ja: {
    thinking_short: ['えっと…', 'ちょっと待って。', 'うーん。'],
    thinking_long: [
      'ちょっと考えさせて。',
      '少しまとめさせてね。',
    ],
    cant_understand: [
      'ごめん、聞こえなかった。',
      'もう一度言ってくれる?',
    ],
    wrong_language: [
      '日本語で話そうか。',
      '日本語で続けようよ。',
    ],
    network_hiccup: [
      'ちょっと待って、通信が不安定みたい。',
      '少し待ってね。',
    ],
    cold_start: [
      'やあ!ちょっと準備させて。',
      'こんにちは、少しだけ待って。',
    ],
  },
  es: {
    thinking_short: ['Mmm…', 'Un segundo.', 'A ver.'],
    thinking_long: [
      'Déjame pensarlo un momento.',
      'Dame un segundo para ordenar las ideas.',
    ],
    cant_understand: [
      'Perdona, no te entendí.',
      '¿Puedes repetirlo?',
    ],
    wrong_language: [
      '¿Seguimos en español?',
      'Hablemos en español.',
    ],
    network_hiccup: [
      'Un momento, mi conexión está rara.',
      'Aguanta un segundo.',
    ],
    cold_start: [
      '¡Hola! Dame un segundo para prepararme.',
      'Hey, un segundo.',
    ],
  },
  ru: {
    thinking_short: ['Хм…', 'Секундочку.', 'Сейчас подумаю.'],
    thinking_long: [
      'Дай мне секунду подумать.',
      'Секунду, соберусь с мыслями.',
    ],
    cant_understand: [
      'Прости, я не расслышал.',
      'Повтори, пожалуйста.',
    ],
    wrong_language: [
      'Давай говорить по-русски, хорошо?',
      'Продолжим на русском.',
    ],
    network_hiccup: [
      'Секунду, связь немного барахлит.',
      'Подожди чуть-чуть.',
    ],
    cold_start: [
      'Привет! Дай секунду освоиться.',
      'Здравствуй, секунду.',
    ],
  },
  ko: {
    thinking_short: ['음…', '잠시만.', '어디 보자.'],
    thinking_long: [
      '잠깐만 생각 좀 할게.',
      '잠시만, 정리 좀 하고.',
    ],
    cant_understand: [
      '미안, 잘 못 들었어.',
      '다시 말해줄래?',
    ],
    wrong_language: [
      '한국어로 얘기할까?',
      '한국어로 계속하자.',
    ],
    network_hiccup: [
      '잠깐, 연결이 좀 불안정해.',
      '잠시만 기다려줘.',
    ],
    cold_start: [
      '안녕! 잠시 준비할게.',
      '안녕하세요, 잠시만.',
    ],
  },
  hi: {
    thinking_short: ['हम्म…', 'एक सेकंड।', 'सोचने दो।'],
    thinking_long: [
      'थोड़ा सोचने दो।',
      'एक पल रुको, मैं सोच रहा हूँ।',
    ],
    cant_understand: [
      'माफ़ करना, समझ नहीं आया।',
      'फिर से कहोगे?',
    ],
    wrong_language: [
      'हिंदी में बात करें?',
      'हिंदी में चलते हैं।',
    ],
    network_hiccup: [
      'रुको, मेरा कनेक्शन थोड़ा गड़बड़ है।',
      'एक पल रुकना।',
    ],
    cold_start: [
      'नमस्ते! एक पल दो, तैयार हो लूँ।',
      'हैलो, एक पल।',
    ],
  },
  pt: {
    thinking_short: ['Hmm…', 'Um segundo.', 'Deixa eu ver.'],
    thinking_long: [
      'Deixa eu pensar um instante.',
      'Me dá um segundo pra juntar as ideias.',
    ],
    cant_understand: [
      'Desculpa, não entendi.',
      'Pode repetir?',
    ],
    wrong_language: [
      'Vamos continuar em português?',
      'Fica em português, ok?',
    ],
    network_hiccup: [
      'Um segundo, minha conexão está estranha.',
      'Aguenta um momento.',
    ],
    cold_start: [
      'Oi! Me dá um segundo pra me ajeitar.',
      'Olá, um instante.',
    ],
  },
  zh: {
    thinking_short: ['嗯…', '稍等。', '让我想想。'],
    thinking_long: [
      '让我想一下。',
      '给我一秒整理思路。',
    ],
    cant_understand: [
      '抱歉,我没听清。',
      '再说一遍好吗?',
    ],
    wrong_language: [
      '我们用中文聊吧?',
      '继续说中文吧。',
    ],
    network_hiccup: [
      '稍等,我的网络有点不稳。',
      '请等一下。',
    ],
    cold_start: [
      '嘿!稍等我一下。',
      '你好,稍等。',
    ],
  },
};

const SCENARIOS = [
  'thinking_short',
  'thinking_long',
  'cant_understand',
  'wrong_language',
  'network_hiccup',
  'cold_start',
];

const SUPPORTED_LANGUAGES = Object.keys(CATALOG);

const getPhrases = (languageCode, scenario) => {
  const lang = CATALOG[languageCode] ? languageCode : 'en';
  const bucket = CATALOG[lang][scenario];
  if (Array.isArray(bucket) && bucket.length) {
    return bucket;
  }
  // Fallback to English if the language doesn't have this scenario filled.
  return CATALOG.en[scenario] || [];
};

const getAllForLanguage = (languageCode) => {
  const out = {};
  const lang = CATALOG[languageCode] ? languageCode : 'en';
  SCENARIOS.forEach((scenario) => {
    out[scenario] = getPhrases(lang, scenario);
  });
  return out;
};

module.exports = {
  CATALOG,
  SCENARIOS,
  SUPPORTED_LANGUAGES,
  getPhrases,
  getAllForLanguage,
};
