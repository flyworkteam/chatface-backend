const { getOpenAIClient, getModerationModel } = require('./openaiClient');
const { warn } = require('./logger');

const DEFAULT_HARD_BLOCK_THRESHOLD = 0.7;
const DEFAULT_SOFT_CATEGORIES = [
  'violence',
  'violence/graphic'
];

const roundScore = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Number(value.toFixed(4));
};

const summarizeModerationResult = (result) => {
  const categories = result?.categories || {};
  const categoryScores = result?.category_scores || result?.categoryScores || {};
  const flaggedCategories = Object.entries(categories)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  const scoreEntries = Object.entries(categoryScores)
    .map(([key, value]) => [key, roundScore(value)])
    .filter(([, value]) => value !== undefined)
    .filter(([key, value]) => flaggedCategories.includes(key) || value >= 0.1)
    .sort(([, left], [, right]) => right - left);
  const scores = Object.fromEntries(scoreEntries);
  const reason = flaggedCategories.join(', ') || 'content_policy';

  return {
    reason,
    flaggedCategories,
    categoryScores: scores
  };
};

const parseHardBlockThreshold = () => {
  const raw = process.env.MODERATION_HARD_BLOCK_THRESHOLD;
  if (raw == null || raw === '') {
    return DEFAULT_HARD_BLOCK_THRESHOLD;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_HARD_BLOCK_THRESHOLD;
  }
  return Math.max(0, Math.min(1, parsed));
};

const parseSoftCategories = () => {
  const raw = process.env.MODERATION_SOFT_CATEGORIES;
  if (!raw || !raw.trim()) {
    return new Set(DEFAULT_SOFT_CATEGORIES);
  }
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
};

const shouldHardBlockFromSummary = ({ summary, threshold, softCategories }) => {
  if (!summary?.flaggedCategories?.length) {
    return false;
  }
  return summary.flaggedCategories.some((category) => {
    const normalizedCategory = String(category || '').toLowerCase();
    const score = summary.categoryScores?.[category];
    // Soft kategori değilse her zaman hard-block.
    if (!softCategories.has(normalizedCategory)) {
      return true;
    }
    // Soft kategorideyse ancak skor eşik üstündeyse hard-block.
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      // Skor yoksa güvenli tarafta kal.
      return true;
    }
    return score >= threshold;
  });
};

const reviewText = async (text) => {
  if (!text) {
    return { blocked: false };
  }

  try {
    const client = getOpenAIClient();
    const response = await client.moderations.create({
      model: getModerationModel(),
      input: text
    });

    const result = Array.isArray(response?.results) ? response.results[0] : null;

    if (!result?.flagged) {
      return { blocked: false };
    }

    const summary = summarizeModerationResult(result);
    const hardBlockThreshold = parseHardBlockThreshold();
    const softCategories = parseSoftCategories();
    const hardBlock = shouldHardBlockFromSummary({
      summary,
      threshold: hardBlockThreshold,
      softCategories
    });

    if (hardBlock) {
      return {
        blocked: true,
        ...summary,
        hardBlockThreshold
      };
    }

    return {
      blocked: false,
      softWarn: true,
      ...summary,
      hardBlockThreshold
    };
  } catch (error) {
    warn('Moderation unavailable, allowing request', error.message);
    return { blocked: false, degraded: true };
  }
};

module.exports = {
  reviewText,
  summarizeModerationResult,
  shouldHardBlockFromSummary
};
