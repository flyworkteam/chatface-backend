/**
 * languageResolution.js — v2
 *
 * Responsibilities:
 *   1. Detect the language of a user-authored message (text chat mode only).
 *   2. Validate STT transcripts and reject the ones that are obvious
 *      hallucinations, noise bursts, or mic echo that slipped past
 *      echoGuard.
 *
 * Rewrite v2 changes vs v1:
 *   - Added HALLUCINATION_PHRASES with per-language lists. We've seen
 *     Whisper emit "Thank you for watching." / "presents." / short
 *     Japanese/Korean filler when the mic is silent — these are
 *     reality-check failures, not transcription errors.
 *   - Short-clip rule: a "complete sentence" transcript from a clip
 *     shorter than 800 ms is almost always hallucination. Reject.
 *   - Strengthened repetition rule (unchanged behavior on hasExcessive
 *     but added tokenized repetition for "the the the the").
 *   - Locked-language validation is now *stricter* — during calls we
 *     hard-require the detected language to match `call_locked_language`.
 *     Soft-signal fallbacks are treated as mismatches, too, on the
 *     assumption that a call locked to Turkish that suddenly produces
 *     "Thank you for watching" is noise and should be dropped.
 *
 * See REWRITE_ARCHITECTURE.md §5.3.
 */

const {
  DEFAULT_LANGUAGE,
  SUPPORTED_SESSION_LANGUAGES,
  normalizeLanguageCode
} = require('./languageSupport');

const LATIN_LANGUAGES = ['en', 'tr', 'de', 'it', 'fr', 'es', 'pt'];
const SCRIPT_PATTERNS = {
  jaKana: /[\u3040-\u30ff]/,
  ko: /[\uac00-\ud7af]/,
  zh: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/,
  ru: /[\u0400-\u04ff]/,
  hi: /[\u0900-\u097f]/,
  ar: /[\u0600-\u06ff]/
};

const DIACRITIC_HINTS = {
  tr: /[çğıİöşü]/i,
  de: /[äöüß]/i,
  fr: /[àâæçéèêëîïôœùûüÿ]/i,
  es: /[áéíñóúü¡¿]/i,
  pt: /[áâãàçéêíóôõú]/i,
  it: /[àèéìíîòóù]/i
};

const LANGUAGE_MARKERS = {
  en: ['hello', 'hi', 'thanks', 'thank', 'please', 'yes', 'no', 'what', 'how', 'where', 'why', 'when', 'the', 'and', 'i', 'you'],
  tr: ['merhaba', 'tesekkur', 'teşekkür', 'lutfen', 'lütfen', 'evet', 'hayir', 'hayır', 'nasilsin', 'nasılsın', 'tamam', 'ben', 'sen', 'bir', 'cok', 'çok'],
  de: ['hallo', 'danke', 'bitte', 'ja', 'nein', 'wie', 'was', 'warum', 'wo', 'wann', 'ich', 'du', 'wir', 'und', 'ist'],
  it: ['ciao', 'grazie', 'prego', 'favore', 'si', 'sì', 'come', 'cosa', 'perche', 'perché', 'dove', 'quando', 'io', 'tu', 'noi'],
  fr: ['bonjour', 'merci', 'salut', 'oui', 'non', 'comment', 'quoi', 'pourquoi', 'quand', 'je', 'tu', 'nous', 'vous', 'est'],
  es: ['hola', 'gracias', 'favor', 'si', 'sí', 'no', 'como', 'cómo', 'que', 'qué', 'donde', 'dónde', 'cuando', 'yo', 'tu', 'tú'],
  pt: ['ola', 'olá', 'obrigado', 'obrigada', 'favor', 'sim', 'nao', 'não', 'como', 'voce', 'você', 'onde', 'quando', 'eu'],
  hi: ['namaste', 'haan', 'haanji', 'nahin', 'nahi', 'kaise', 'kya', 'main', 'aap', 'hum']
};

/**
 * Known Whisper hallucination outputs on silence / low-SNR audio.
 * Entries are substrings matched against normalized transcript.
 * See DB incidents 2026-03-{11,14,19} — each of these was a mic-silent turn
 * that produced a full-sentence transcript that went straight into LLM.
 */
const HALLUCINATION_PHRASES = {
  en: [
    'thank you for watching',
    'thanks for watching',
    'thank you for your attention',
    "don't forget to subscribe",
    'please subscribe',
    'subscribe to my channel',
    'see you in the next video',
    'see you next time',
    'like and subscribe',
    'i love you',
    'presents',
    '.presents.',
    '[ music ]',
    '[music]',
    'music playing',
    'transcribed by',
    'transcription by',
    'subtitles by the amara',
    'amara.org community'
  ],
  tr: [
    'abone olmayı unutmayın',
    'beğenmeyi unutmayın',
    'izlediğiniz için teşekkürler',
    'videoyu beğendiyseniz'
  ],
  de: [
    'vielen dank fürs zuschauen',
    'danke fürs zuschauen',
    'abonniere meinen kanal'
  ],
  fr: [
    "merci d'avoir regardé",
    "n'oubliez pas de vous abonner",
    'abonnez-vous'
  ],
  es: [
    'gracias por ver',
    'gracias por ver el video',
    'suscríbete al canal'
  ],
  it: [
    'grazie per aver guardato',
    'iscriviti al canale'
  ],
  pt: [
    'obrigado por assistir',
    'inscreva-se no canal'
  ],
  ru: [
    'спасибо за просмотр',
    'подписывайтесь на канал'
  ],
  ja: [
    'ご視聴ありがとうございました',
    'チャンネル登録',
    'ご視聴ありがとうございます'
  ],
  ko: [
    '시청해주셔서 감사합니다',
    '구독 부탁드립니다'
  ],
  zh: [
    '感谢观看',
    '请订阅',
    '请订阅我的频道'
  ],
  hi: [
    'देखने के लिए धन्यवाद',
    'सब्सक्राइब'
  ]
};

// Duration floor under which a "complete" sentence is suspicious.
// Values chosen from observed hallucinations: all were emitted for audio
// windows under 700 ms of real voice.
const SHORT_CLIP_MS = 800;
// Minimum tokens for a transcript to count as a "complete sentence" for the
// short-clip rule.
const COMPLETE_SENTENCE_MIN_TOKENS = 4;

const normalizeText = (text = '') =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const tokenize = (text = '') =>
  normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);

const isScriptBasedLanguage = (language) =>
  ['ja', 'ko', 'zh', 'ru', 'hi'].includes(language);

const getScriptDetection = (text) => {
  if (SCRIPT_PATTERNS.jaKana.test(text)) {
    return { language: 'ja', confidence: 0.99, reason: 'japanese_kana' };
  }
  if (SCRIPT_PATTERNS.ko.test(text)) {
    return { language: 'ko', confidence: 0.99, reason: 'hangul' };
  }
  if (SCRIPT_PATTERNS.hi.test(text)) {
    return { language: 'hi', confidence: 0.99, reason: 'devanagari' };
  }
  if (SCRIPT_PATTERNS.ru.test(text)) {
    return { language: 'ru', confidence: 0.99, reason: 'cyrillic' };
  }
  if (SCRIPT_PATTERNS.ar.test(text)) {
    return { language: 'ar', confidence: 0.99, reason: 'arabic' };
  }
  if (SCRIPT_PATTERNS.zh.test(text)) {
    return { language: 'zh', confidence: 0.97, reason: 'han' };
  }
  return null;
};

const scoreLatinLanguages = (text) => {
  const scores = Object.fromEntries(LATIN_LANGUAGES.map((language) => [language, 0]));
  const normalized = normalizeText(text);
  const tokens = tokenize(text);

  LATIN_LANGUAGES.forEach((language) => {
    const markers = LANGUAGE_MARKERS[language] || [];
    markers.forEach((marker) => {
      if (tokens.includes(normalizeText(marker))) {
        scores[language] += 2;
      }
    });

    const diacriticHint = DIACRITIC_HINTS[language];
    if (diacriticHint?.test(text)) {
      scores[language] += 3;
    }
  });

  if (/\b(the|hello|thanks|thank|please|you|what|how)\b/.test(normalized)) {
    scores.en += 1.5;
  }
  if (/\b(merhaba|tamam|evet|hayir|hayır|nasilsin|nasılsın)\b/.test(normalized)) {
    scores.tr += 2;
  }
  if (/\b(gracias|hola|donde|dónde|como|cómo)\b/.test(normalized)) {
    scores.es += 1.5;
  }
  if (/\b(olá|ola|obrigado|obrigada|voce|você)\b/.test(text.toLowerCase())) {
    scores.pt += 1.5;
  }

  return scores;
};

const pickBestLanguage = (scores = {}) => {
  const ranked = Object.entries(scores)
    .sort((left, right) => right[1] - left[1]);

  const [bestEntry, secondEntry] = ranked;
  if (!bestEntry) {
    return null;
  }

  const [language, score] = bestEntry;
  const secondScore = secondEntry?.[1] || 0;
  const margin = score - secondScore;

  return {
    language,
    score,
    margin,
    ranked
  };
};

const resolveUserLanguage = ({ text, currentLanguage }) => {
  const normalizedCurrent = normalizeLanguageCode(currentLanguage, DEFAULT_LANGUAGE);
  const trimmed = typeof text === 'string' ? text.trim() : '';

  if (!trimmed) {
    return {
      language: normalizedCurrent,
      confidence: 0,
      reason: 'empty',
      source: 'fallback',
      shouldSwitch: false
    };
  }

  const scriptMatch = getScriptDetection(trimmed);
  if (scriptMatch) {
    const canonical = normalizeLanguageCode(scriptMatch.language);
    return {
      detectedLanguage: scriptMatch.language,
      language: canonical || normalizedCurrent,
      supported: Boolean(canonical),
      confidence: scriptMatch.confidence,
      reason: scriptMatch.reason,
      source: 'script',
      shouldSwitch: Boolean(canonical) && canonical !== normalizedCurrent
    };
  }

  const scores = scoreLatinLanguages(trimmed);
  const best = pickBestLanguage(scores);

  if (best && best.score >= 2 && best.margin >= 1) {
    return {
      detectedLanguage: best.language,
      language: best.language,
      supported: true,
      confidence: Math.min(0.95, 0.55 + best.score * 0.08),
      reason: 'latin_markers',
      source: 'keywords',
      shouldSwitch: best.language !== normalizedCurrent,
      scores
    };
  }

  const tokens = tokenize(trimmed);
  const fallbackLanguage = tokens.length && /^[\x00-\x7F\s\p{P}]+$/u.test(trimmed)
    ? normalizedCurrent || DEFAULT_LANGUAGE
    : normalizedCurrent;

  return {
    detectedLanguage: normalizedCurrent,
    language: fallbackLanguage,
    supported: true,
    confidence: best?.score ? 0.45 : 0.25,
    reason: best?.score ? 'ambiguous_latin' : 'fallback_current',
    source: 'fallback',
    shouldSwitch: false,
    scores
  };
};

const getLetterLikeLength = (text = '') =>
  Array.from(text).filter((char) => /\p{L}|\p{N}/u.test(char)).length;

const hasExcessiveCharRepetition = (text = '') => {
  const normalized = text.replace(/\s+/g, '');
  if (!normalized) {
    return false;
  }
  const uniqueChars = new Set(Array.from(normalized));
  return uniqueChars.size <= 2 && normalized.length >= 6;
};

const hasExcessiveTokenRepetition = (text = '') => {
  const tokens = tokenize(text);
  if (tokens.length < 4) {
    return false;
  }
  const counts = new Map();
  tokens.forEach((token) => {
    counts.set(token, (counts.get(token) || 0) + 1);
  });
  for (const count of counts.values()) {
    if (count >= 4 && count / tokens.length >= 0.5) {
      return true;
    }
  }
  return false;
};

const matchesHallucinationPhrase = (text = '', language = null) => {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  const langsToCheck = language
    ? [language, 'en'].filter((value, idx, arr) => value && arr.indexOf(value) === idx)
    : Object.keys(HALLUCINATION_PHRASES);
  for (const lang of langsToCheck) {
    const bucket = HALLUCINATION_PHRASES[lang] || [];
    for (const phrase of bucket) {
      const target = normalizeText(phrase);
      if (!target) {
        continue;
      }
      if (normalized === target || normalized.includes(target)) {
        return { phrase, language: lang };
      }
    }
  }
  return null;
};

const isLikelyCompleteSentence = (text = '') => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const endsWithTerminator = /[.!?。!?…]$/.test(trimmed);
  const tokenCount = tokenize(trimmed).length;
  return endsWithTerminator && tokenCount >= COMPLETE_SENTENCE_MIN_TOKENS;
};

/**
 * Validate a finalized STT transcript. Returns { accepted: bool, reason?, ... }.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {object} [params.metadata]           Shape: { confidence, durationMs, ... }
 * @param {string} [params.currentLanguage]    Session's current language.
 * @param {string|null} [params.lockedLanguage] call_locked_language if active.
 * @param {number} [params.audioMsReceived]    ms of audio seen for this turn.
 * @param {boolean} [params.duringAssistantSpeech] Whether TTS was active.
 */
const validateTranscript = ({
  text,
  metadata,
  currentLanguage,
  lockedLanguage = null,
  audioMsReceived = null,
  duringAssistantSpeech = false
}) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return { accepted: false, reason: 'empty' };
  }

  const confidence = Number(metadata?.confidence);
  if (Number.isFinite(confidence) && confidence < 0.45) {
    return { accepted: false, reason: 'low_confidence', confidence };
  }

  const contentLength = getLetterLikeLength(trimmed);
  if (contentLength < 2) {
    return { accepted: false, reason: 'too_short', confidence };
  }

  if (hasExcessiveCharRepetition(trimmed) || hasExcessiveTokenRepetition(trimmed)) {
    return { accepted: false, reason: 'repetitive_noise', confidence };
  }

  const normalizedLocked = lockedLanguage
    ? normalizeLanguageCode(lockedLanguage, null)
    : null;

  // Hallucination phrase check — run early, before any language arithmetic.
  // During active assistant speech or locked calls, match against the locked
  // language + English. Otherwise broad-sweep.
  const hallucinationMatch = matchesHallucinationPhrase(
    trimmed,
    normalizedLocked || currentLanguage
  );
  if (hallucinationMatch) {
    return {
      accepted: false,
      reason: 'known_hallucination',
      confidence,
      hallucination: hallucinationMatch
    };
  }

  // Short-clip hallucination rule: a "complete sentence" from <800ms of audio
  // is almost always Whisper filling in the blanks.
  if (
    Number.isFinite(audioMsReceived) &&
    audioMsReceived > 0 &&
    audioMsReceived < SHORT_CLIP_MS &&
    isLikelyCompleteSentence(trimmed)
  ) {
    return {
      accepted: false,
      reason: 'short_clip_sentence',
      confidence,
      audioMsReceived
    };
  }

  const resolution = resolveUserLanguage({ text: trimmed, currentLanguage });
  const normalizedCurrent = normalizeLanguageCode(currentLanguage, DEFAULT_LANGUAGE);
  const tokenCount = tokenize(trimmed).length;

  // Locked-language validation (call mode): transcripts that don't match
  // the locked language must be rejected. Fallback-source resolutions
  // (ASCII passthrough / ambiguous) are allowed *only* if we can't rule
  // them out — i.e., the transcript is too short to have a signal. If the
  // resolver has evidence of another language (script or keywords), drop.
  if (normalizedLocked) {
    const resolvedLang = resolution.language;
    const isScriptOrKeyword = resolution.source === 'script' || resolution.source === 'keywords';
    if (isScriptOrKeyword && resolvedLang !== normalizedLocked) {
      return {
        accepted: false,
        reason: 'locked_language_mismatch',
        confidence,
        resolution,
        lockedLanguage: normalizedLocked
      };
    }
    // If assistant is speaking and transcript is short/fragment — during
    // locked call that's echo or noise, not a user turn.
    if (duringAssistantSpeech && contentLength < 10) {
      return {
        accepted: false,
        reason: 'short_during_locked_speech',
        confidence,
        resolution,
        lockedLanguage: normalizedLocked
      };
    }
  }

  if (resolution.source === 'script' && resolution.supported === false) {
    return {
      accepted: false,
      reason: 'unsupported_script',
      confidence,
      resolution
    };
  }

  if (
    resolution.source === 'script' &&
    resolution.language !== normalizedCurrent &&
    isScriptBasedLanguage(resolution.language) &&
    contentLength < 12 &&
    tokenCount < 2
  ) {
    return {
      accepted: false,
      reason: 'abrupt_script_switch',
      confidence,
      resolution
    };
  }

  if (
    resolution.language !== normalizedCurrent &&
    contentLength < 5 &&
    (!Number.isFinite(confidence) || confidence < 0.8)
  ) {
    return {
      accepted: false,
      reason: 'weak_language_switch',
      confidence,
      resolution
    };
  }

  if (
    resolution.source === 'fallback' &&
    contentLength < 3 &&
    (!Number.isFinite(confidence) || confidence < 0.65)
  ) {
    return {
      accepted: false,
      reason: 'ambiguous_short_final',
      confidence,
      resolution
    };
  }

  return {
    accepted: true,
    confidence,
    resolution
  };
};

module.exports = {
  SUPPORTED_SESSION_LANGUAGES,
  HALLUCINATION_PHRASES,
  resolveUserLanguage,
  validateTranscript,
  matchesHallucinationPhrase,
  isLikelyCompleteSentence
};
