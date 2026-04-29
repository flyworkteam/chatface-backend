/**
 * echoGuard.js — v2
 *
 * Detects when the microphone has captured the assistant's own TTS audio
 * re-entering the STT pipeline as a "user" transcript.
 *
 * Rewrite changes vs v1:
 *  - Wider recent-speech memory window (60 s vs 20 s) to cover long pauses.
 *  - Lower token/bigram thresholds so partial echoes get caught.
 *  - Always-on sliding-window substring scan (not just full-string contains).
 *  - Short-transcript hard-gate when TTS is actively playing.
 *  - Returns match scores for observability — orchestrator logs them.
 *
 * See REWRITE_ARCHITECTURE.md §7.
 */

const RECENT_WINDOW_MS = 60000;
const MAX_RECENT_SEGMENTS = 24;
const MIN_TEXT_LENGTH = 6;

// Strict thresholds (applied when the candidate assistant speech is older than
// RECENT_ECHO_GRACE_MS). The assumption: if echo is happening this late, the
// match has to be strong to be convincing.
const MIN_TOKEN_OVERLAP = 0.62;
const MIN_BIGRAM_SIMILARITY = 0.7;

// Loose thresholds (applied within RECENT_ECHO_GRACE_MS). The mic is still hot
// and partials dribble in — catch aggressively.
const RECENT_ECHO_GRACE_MS = 8000;
const RECENT_MIN_TOKEN_OVERLAP = 0.45;
const RECENT_MIN_BIGRAM_SIMILARITY = 0.55;

// Sliding-window substring scan — catch the case where only part of the
// assistant sentence got picked up by the mic.
const WINDOW_TOKEN_LENGTH = 6;
const WINDOW_MIN_TOKEN_OVERLAP = 0.85;

// When TTS is actively playing, very short transcripts are almost always echo
// (single word affirmations, breath sounds, the tail of the assistant's voice).
const SHORT_TRANSCRIPT_DURING_SPEECH_MAX_CHARS = 10;

const MIN_SPEECH_WINDOW_MS = 900;
const MAX_SPEECH_WINDOW_MS = 8000;
const SPEECH_WINDOW_BUFFER_MS = 500;

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

/**
 * Slide a 6-token window of the transcript across the candidate and report
 * the best token-overlap score. Catches the case where the mic grabbed only
 * the middle of an assistant sentence.
 */
const bestWindowOverlap = (transcriptText, candidateText) => {
  const transcriptTokens = tokenize(transcriptText);
  if (transcriptTokens.length < WINDOW_TOKEN_LENGTH) {
    return computeTokenOverlap(transcriptText, candidateText);
  }
  let best = 0;
  for (let i = 0; i + WINDOW_TOKEN_LENGTH <= transcriptTokens.length; i += 1) {
    const windowText = transcriptTokens
      .slice(i, i + WINDOW_TOKEN_LENGTH)
      .join(' ');
    const score = computeTokenOverlap(windowText, candidateText);
    if (score > best) {
      best = score;
    }
  }
  return best;
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
  const estimatedMs = (wordCount * 220) + SPEECH_WINDOW_BUFFER_MS;
  return Math.max(MIN_SPEECH_WINDOW_MS, Math.min(MAX_SPEECH_WINDOW_MS, estimatedMs));
};

const markAssistantSpeechActive = ({ sessionId, text, durationMs }) => {
  if (!sessionId) {
    return;
  }
  const now = Date.now();
  const currentUntil = activeSpeechWindowsBySession.get(sessionId) || 0;
  const windowMs = typeof durationMs === 'number' && durationMs > 0
    ? Math.max(MIN_SPEECH_WINDOW_MS, Math.min(MAX_SPEECH_WINDOW_MS, durationMs + SPEECH_WINDOW_BUFFER_MS))
    : estimateSpeechWindowMs(text);
  const nextUntil = now + windowMs;
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

const rememberAssistantSpeech = ({ sessionId, text, playbackId, durationMs }) => {
  const normalized = normalizeText(text);
  if (!sessionId) {
    return;
  }

  markAssistantSpeechActive({ sessionId, text, durationMs });

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

/**
 * Core echo detection. Returns null if not echo, or a match object with scores.
 */
const findEchoMatch = ({ sessionId, transcript }) => {
  const normalizedTranscript = normalizeText(transcript);
  if (!sessionId) {
    return null;
  }

  const now = Date.now();
  const assistantActive = isAssistantSpeechActive({ sessionId, now });

  // Short-transcript hard-gate during active assistant speech.
  if (
    assistantActive &&
    normalizedTranscript.length > 0 &&
    normalizedTranscript.length <= SHORT_TRANSCRIPT_DURING_SPEECH_MAX_CHARS
  ) {
    return {
      playbackId: null,
      matchedText: '[assistant_active_short_transcript]',
      tokenOverlap: 1,
      bigramSimilarity: 1,
      ageMs: 0,
      reason: 'short_during_speech',
    };
  }

  if (normalizedTranscript.length < MIN_TEXT_LENGTH) {
    return null;
  }

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
    const windowOverlap = bestWindowOverlap(normalizedTranscript, candidate.normalized);
    const containsMatch =
      candidate.normalized.includes(normalizedTranscript) ||
      normalizedTranscript.includes(candidate.normalized);
    const isRecent = ageMs <= RECENT_ECHO_GRACE_MS;
    const overlapThreshold = isRecent ? RECENT_MIN_TOKEN_OVERLAP : MIN_TOKEN_OVERLAP;
    const bigramThreshold = isRecent ? RECENT_MIN_BIGRAM_SIMILARITY : MIN_BIGRAM_SIMILARITY;

    const nearFullLength =
      Math.min(normalizedTranscript.length, candidate.normalized.length) /
        Math.max(normalizedTranscript.length, candidate.normalized.length) >=
      0.8;
    const containmentPasses = containsMatch && (assistantActive || isRecent || nearFullLength);

    const passesByFull =
      containmentPasses ||
      (tokenOverlap >= overlapThreshold && bigramSimilarity >= bigramThreshold);
    const passesByWindow = windowOverlap >= WINDOW_MIN_TOKEN_OVERLAP;

    if (passesByFull || passesByWindow) {
      return {
        playbackId: candidate.playbackId,
        matchedText: candidate.text,
        tokenOverlap: Number(tokenOverlap.toFixed(3)),
        bigramSimilarity: Number(bigramSimilarity.toFixed(3)),
        windowOverlap: Number(windowOverlap.toFixed(3)),
        ageMs,
        reason: passesByFull ? 'full_match' : 'window_match',
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
  markAssistantSpeechActive,
};
