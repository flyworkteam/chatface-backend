const MISS_TTL_MS = parseInt(process.env.TTS_CACHE_MISS_TTL_MS || '86400000', 10); // 24h
const DEFAULT_REPORT_LIMIT = parseInt(process.env.TTS_CACHE_MISS_REPORT_LIMIT || '30', 10);

const misses = new Map();

const normalizeText = (text = '') =>
  String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 220);

const makeMissKey = ({ personaId, language, variant = 'default', text }) =>
  `${String(personaId || '')}::${String(language || '')}::${String(variant || 'default')}::${normalizeText(text).toLowerCase()}`;

const recordTtsCacheMiss = ({ personaId, language, variant = 'default', text }) => {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return;
  }

  const key = makeMissKey({ personaId, language, variant, text: normalizedText });
  const now = Date.now();
  const existing = misses.get(key);

  if (!existing) {
    misses.set(key, {
      personaId,
      language,
      variant,
      text: normalizedText,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now
    });
    return;
  }

  existing.count += 1;
  existing.lastSeenAt = now;
};

const purgeExpiredMisses = () => {
  const threshold = Date.now() - Math.max(60000, MISS_TTL_MS);
  for (const [key, entry] of misses.entries()) {
    if (entry.lastSeenAt < threshold) {
      misses.delete(key);
    }
  }
};

const getTopTtsCacheMisses = ({ limit = DEFAULT_REPORT_LIMIT } = {}) => {
  purgeExpiredMisses();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || DEFAULT_REPORT_LIMIT));

  return Array.from(misses.values())
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return right.lastSeenAt - left.lastSeenAt;
    })
    .slice(0, safeLimit)
    .map((entry) => ({
      personaId: entry.personaId,
      language: entry.language,
      variant: entry.variant,
      text: entry.text,
      missCount: entry.count,
      firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
      lastSeenAt: new Date(entry.lastSeenAt).toISOString()
    }));
};

module.exports = {
  recordTtsCacheMiss,
  getTopTtsCacheMisses
};
