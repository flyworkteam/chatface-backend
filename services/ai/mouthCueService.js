const axios = require('axios');
const { debug, log } = require('./logger');

const DEFAULT_MOUTH_CUE_URL = 'https://viseme.fly-work.com/viseme';
const REQUEST_TIMEOUT_MS = parseInt(process.env.MOUTH_CUE_TIMEOUT_MS || '2000', 10);
const FAILURE_COOLDOWN_MS = parseInt(process.env.MOUTH_CUE_FAILURE_COOLDOWN_MS || '300000', 10);
const serviceUrl = process.env.MOUTH_CUE_SERVICE_URL || DEFAULT_MOUTH_CUE_URL;
const inflightRequests = new Map();
const failureBackoff = new Map();

const parseVisemeResponse = (raw) => {
  let payload = raw;

  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (_error) {
      return [];
    }
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = [
    payload.visemes,
    payload.mouthCues,
    payload.cues,
    payload.data
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
};

const fetchMouthCues = async ({ audioUrl, cacheKey }) => {
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
    return [];
  }

  const now = Date.now();
  const blockedUntil = failureBackoff.get(cacheKey) || 0;
  if (blockedUntil > now) {
    return [];
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const request = (async () => {
    try {
      const response = await axios.post(
        serviceUrl,
        { audioUrl },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      const cues = parseVisemeResponse(response.data);
      if (cues.length) {
        log('Mouth cues enriched', { cacheKey, cueCount: cues.length });
      } else {
        failureBackoff.set(cacheKey, Date.now() + FAILURE_COOLDOWN_MS);
      }
      return cues;
    } catch (error) {
      failureBackoff.set(cacheKey, Date.now() + FAILURE_COOLDOWN_MS);
      debug('Mouth cue enrichment skipped', {
        cacheKey,
        message: error.message
      });
      return [];
    } finally {
      inflightRequests.delete(cacheKey);
    }
  })();

  inflightRequests.set(cacheKey, request);
  return request;
};

module.exports = {
  fetchMouthCues
};
