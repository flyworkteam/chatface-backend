const { isRecoverableError } = require('./errors');

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 150,
    maxDelayMs = 2000,
    factor = 2
  } = options;

  let attempt = 0;
  let delay = baseDelayMs;
  let lastError = null;

  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRecoverableError(error) || attempt === retries) {
        throw error;
      }
      await wait(delay);
      delay = Math.min(maxDelayMs, delay * factor);
      attempt += 1;
    }
  }

  throw lastError;
}

module.exports = {
  retryWithBackoff
};
