const { getOpenAIClient, getModerationModel } = require('./openaiClient');
const { warn } = require('./logger');

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
    const categories = result?.categories || {};

    if (!result?.flagged) {
      return { blocked: false };
    }

    const reason = Object.entries(categories)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .join(', ') || 'content_policy';

    return {
      blocked: true,
      reason
    };
  } catch (error) {
    warn('Moderation unavailable, allowing request', error.message);
    return { blocked: false, degraded: true };
  }
};

module.exports = {
  reviewText
};
