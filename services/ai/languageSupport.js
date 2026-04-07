const DEFAULT_LANGUAGE = process.env.DEFAULT_AI_LANGUAGE || 'en';

const CANONICAL_LANGUAGE_NAMES = {
  en: 'English',
  zh: 'Chinese',
  de: 'German',
  it: 'Italian',
  fr: 'French',
  ja: 'Japanese',
  es: 'Spanish',
  ru: 'Russian',
  tr: 'Turkish',
  ko: 'Korean',
  hi: 'Hindi',
  pt: 'Portuguese'
};

const LANGUAGE_ALIASES = {
  ch: 'zh',
  cn: 'zh',
  jp: 'ja',
  kr: 'ko',
  br: 'pt'
};

const SUPPORTED_SESSION_LANGUAGES = new Set(Object.keys(CANONICAL_LANGUAGE_NAMES));

const normalizeLanguageCode = (value, fallback = null) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  const canonical = LANGUAGE_ALIASES[normalized] || normalized;
  return SUPPORTED_SESSION_LANGUAGES.has(canonical) ? canonical : fallback;
};

const isSupportedLanguageCode = (value) =>
  Boolean(normalizeLanguageCode(value));

const getLanguageName = (value, fallback = CANONICAL_LANGUAGE_NAMES[DEFAULT_LANGUAGE] || 'English') => {
  const normalized = normalizeLanguageCode(value);
  return normalized ? CANONICAL_LANGUAGE_NAMES[normalized] : fallback;
};

module.exports = {
  CANONICAL_LANGUAGE_NAMES,
  DEFAULT_LANGUAGE,
  SUPPORTED_SESSION_LANGUAGES,
  getLanguageName,
  isSupportedLanguageCode,
  normalizeLanguageCode
};
