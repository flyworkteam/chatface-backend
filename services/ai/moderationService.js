const { getOpenAIClient, getModerationModel } = require('./openaiClient');
const { warn } = require('./logger');

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

    return {
      blocked: true,
      ...summary
    };
  } catch (error) {
    warn('Moderation unavailable, allowing request', error.message);
    return { blocked: false, degraded: true };
  }
};

module.exports = {
  reviewText,
  summarizeModerationResult
};
