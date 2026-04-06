const flaggedCategories = ['self_harm', 'hate', 'violence'];

const reviewText = async (text) => {
  // Placeholder for Gemini moderation or third-party API.
  // For now we only perform a naive filter to keep the pipeline non-blocking.
  const containsFlag = flaggedCategories.some((category) => {
    return text.toLowerCase().includes(category.replace('_', ' '));
  });

  if (containsFlag) {
    return { blocked: true, reason: 'content_policy' };
  }

  return { blocked: false };
};

module.exports = {
  reviewText
};
