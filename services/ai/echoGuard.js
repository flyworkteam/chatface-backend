const RECENT_WINDOW_MS = 20000;
const MAX_RECENT_SEGMENTS = 12;
const MIN_TEXT_LENGTH = 8;
const MIN_TOKEN_OVERLAP = 0.72;
const MIN_BIGRAM_SIMILARITY = 0.82;
const RECENT_ECHO_GRACE_MS = 8000;
const RECENT_MIN_TOKEN_OVERLAP = 0.58;
const RECENT_MIN_BIGRAM_SIMILARITY = 0.7;
const MIN_SPEECH_WINDOW_MS = 1800;
const MAX_SPEECH_WINDOW_MS = 15000;
const SPEECH_WINDOW_BUFFER_MS = 900;

const recentSpeechBySession = new Map();
const activeSpeechWindowsBySession = new Map();

const normalizeText = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (value = '') => normalizeText(value).split(' ').filter(Boolean);

const buildBigrams = (value = '') => {
  const normalized = normalizeText(value).replace(/\s/g, '');
  if (normalized.length < 2) {
    return new Set(normalized ? [normalized] : []);
  }
  const result = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
};

const computeTokenOverlap = (leftText, rightText) => {
  const leftTokens = tokenize(leftText);
  const rightTokens = tokenize(rightText);
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  leftSet.forEach((token) => {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  });

  return intersection / Math.max(leftSet.size, rightSet.size);
};

const computeBigramSimilarity = (leftText, rightText) => {
  const left = buildBigrams(leftText);
  const right = buildBigrams(rightText);
  if (!left.size || !right.size) {
    return 0;
  }

  let intersection = 0;
  left.forEach((item) => {
    if (right.has(item)) {
      intersection += 1;
    }
  });

  return (2 * intersection) / (left.size + right.size);
};

const pruneSessionEntries = (sessionId, now = Date.now()) => {
  const entries = recentSpeechBySession.get(sessionId) || [];
  const filtered = entries.filter((entry) => now - entry.timestamp <= RECENT_WINDOW_MS);
  if (filtered.length) {
    recentSpeechBySession.set(sessionId, filtered.slice(-MAX_RECENT_SEGMENTS));
  } else {
    recentSpeechBySession.delete(sessionId);
  }
  return filtered;
};

const estimateSpeechWindowMs = (text = '') => {
  const normalized = normalizeText(text);
  if (!normalized) {
    return MIN_SPEECH_WINDOW_MS;
  }

  const wordCount = normalized.split(' ').filter(Boolean).length;
  const estimatedMs = (wordCount * 360) + SPEECH_WINDOW_BUFFER_MS;
  return Math.max(MIN_SPEECH_WINDOW_MS, Math.min(MAX_SPEECH_WINDOW_MS, estimatedMs));
};

const markAssistantSpeechActive = ({ sessionId, text }) => {
  if (!sessionId) {
    return;
  }

  const now = Date.now();
  const currentUntil = activeSpeechWindowsBySession.get(sessionId) || 0;
  const nextUntil = now + estimateSpeechWindowMs(text);
  activeSpeechWindowsBySession.set(sessionId, Math.max(currentUntil, nextUntil));
};

const isAssistantSpeechActive = ({ sessionId, now = Date.now() }) => {
  if (!sessionId) {
    return false;
  }

  const activeUntil = activeSpeechWindowsBySession.get(sessionId) || 0;
  if (activeUntil <= now) {
    activeSpeechWindowsBySession.delete(sessionId);
    return false;
  }

  return true;
};

const rememberAssistantSpeech = ({ sessionId, text, playbackId }) => {
  const normalized = normalizeText(text);
  if (!sessionId) {
    return;
  }

  markAssistantSpeechActive({ sessionId, text });

  if (normalized.length < MIN_TEXT_LENGTH) {
    return;
  }

  const now = Date.now();
  const entries = pruneSessionEntries(sessionId, now);
  entries.push({
    playbackId: playbackId || null,
    text,
    normalized,
    timestamp: now,
  });
  recentSpeechBySession.set(sessionId, entries.slice(-MAX_RECENT_SEGMENTS));
};

const findEchoMatch = ({ sessionId, transcript }) => {
  const normalizedTranscript = normalizeText(transcript);
  if (!sessionId || normalizedTranscript.length < MIN_TEXT_LENGTH) {
    return null;
  }

  const now = Date.now();
  const entries = pruneSessionEntries(sessionId, now);
  if (!entries.length) {
    return null;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    const ageMs = now - candidate.timestamp;
    const tokenOverlap = computeTokenOverlap(normalizedTranscript, candidate.normalized);
    const bigramSimilarity = computeBigramSimilarity(
      normalizedTranscript,
      candidate.normalized
    );
    const containsMatch =
      candidate.normalized.includes(normalizedTranscript) ||
      normalizedTranscript.includes(candidate.normalized);
    const isRecent = ageMs <= RECENT_ECHO_GRACE_MS;
    const overlapThreshold = isRecent ? RECENT_MIN_TOKEN_OVERLAP : MIN_TOKEN_OVERLAP;
    const bigramThreshold = isRecent
      ? RECENT_MIN_BIGRAM_SIMILARITY
      : MIN_BIGRAM_SIMILARITY;

    if (
      containsMatch ||
      (tokenOverlap >= overlapThreshold &&
        bigramSimilarity >= bigramThreshold)
    ) {
      return {
        playbackId: candidate.playbackId,
        matchedText: candidate.text,
        tokenOverlap: Number(tokenOverlap.toFixed(3)),
        bigramSimilarity: Number(bigramSimilarity.toFixed(3)),
        ageMs,
      };
    }
  }

  return null;
};

const clearSessionSpeech = (sessionId) => {
  if (!sessionId) {
    return;
  }
  recentSpeechBySession.delete(sessionId);
  activeSpeechWindowsBySession.delete(sessionId);
};

module.exports = {
  rememberAssistantSpeech,
  findEchoMatch,
  isAssistantSpeechActive,
  clearSessionSpeech,
};
