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

const hasExcessiveRepetition = (text = '') => {
  const normalized = text.replace(/\s+/g, '');
  if (!normalized) {
    return false;
  }
  const uniqueChars = new Set(Array.from(normalized));
  return uniqueChars.size <= 2 && normalized.length >= 6;
};

const validateTranscript = ({ text, metadata, currentLanguage, lockedLanguage = null }) => {
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

  if (hasExcessiveRepetition(trimmed)) {
    return { accepted: false, reason: 'repetitive_noise', confidence };
  }

  const resolution = resolveUserLanguage({ text: trimmed, currentLanguage });
  const normalizedCurrent = normalizeLanguageCode(currentLanguage, DEFAULT_LANGUAGE);
  const normalizedLocked = lockedLanguage
    ? normalizeLanguageCode(lockedLanguage, null)
    : null;
  const tokenCount = tokenize(trimmed).length;

  if (
    normalizedLocked &&
    resolution.language !== normalizedLocked &&
    resolution.source !== 'fallback'
  ) {
    return {
      accepted: false,
      reason: 'locked_language_mismatch',
      confidence,
      resolution
    };
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
  resolveUserLanguage,
  validateTranscript
};
