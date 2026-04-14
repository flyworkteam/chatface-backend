const crypto = require('crypto');
const { PassThrough } = require('stream');
const { log, warn } = require('./logger');

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value || fallback, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : parseInt(fallback, 10);
};

const STREAM_TTL_MS = parsePositiveInt(process.env.TTS_LIVE_STREAM_TTL_MS, '120000');
const REPLAY_TTL_MS = parsePositiveInt(process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS, '60000');
const streams = new Map();

const getSecret = () =>
  process.env.TTS_STREAM_SECRET || process.env.JWT_SECRET || 'chatface-tts-stream-dev-secret';

const signStream = (id, sessionId, userId, expiresAt) =>
  crypto
    .createHmac('sha256', getSecret())
    .update(`${id}:${sessionId}:${userId}:${expiresAt}`)
    .digest('hex');

const cleanupStream = (id) => {
  const stream = streams.get(id);
  if (!stream) {
    return;
  }
  if (stream.cleanupTimer) {
    clearTimeout(stream.cleanupTimer);
  }
  streams.delete(id);
};

const scheduleCleanup = (stream, delayMs) => {
  if (stream.cleanupTimer) {
    clearTimeout(stream.cleanupTimer);
  }
  const delay = Math.max(0, delayMs);
  stream.cleanupTimer = setTimeout(() => cleanupStream(stream.id), delay);
  stream.cleanupTimer.unref?.();
};

const bufferedByteLength = (stream) =>
  stream.chunks.reduce((total, chunk) => total + chunk.length, 0);

const createLiveTtsStream = ({ sessionId, userId, sequence, playbackId }) => {
  const id = crypto.randomBytes(18).toString('hex');
  const expiresAt = Date.now() + STREAM_TTL_MS;
  const token = signStream(id, sessionId, userId, expiresAt);
  const stream = {
    id,
    sessionId,
    userId,
    sequence,
    playbackId,
    expiresAt,
    token,
    createdAt: Date.now(),
    chunks: [],
    consumers: new Set(),
    attachCount: 0,
    ended: false,
    failed: false,
    firstChunkAt: null,
    cleanupTimer: null
  };
  scheduleCleanup(stream, STREAM_TTL_MS);
  streams.set(id, stream);

  return {
    id,
    url: `/api/ai/tts/live/${id}?token=${encodeURIComponent(token)}`
  };
};

const appendLiveTtsStream = (id, chunk) => {
  const stream = streams.get(id);
  if (!stream || stream.ended || stream.failed || !chunk?.length) {
    return;
  }
  const buffer = Buffer.from(chunk);
  stream.firstChunkAt = stream.firstChunkAt || Date.now();
  stream.chunks.push(buffer);
  stream.consumers.forEach((consumer) => {
    if (!consumer.destroyed) {
      consumer.write(buffer);
    }
  });
};

const finishLiveTtsStream = (id) => {
  const stream = streams.get(id);
  if (!stream || stream.ended) {
    return;
  }
  stream.ended = true;
  stream.consumers.forEach((consumer) => {
    if (!consumer.destroyed) {
      consumer.end();
    }
  });
  const remainingSignedTtlMs = Math.max(stream.expiresAt - Date.now(), 0);
  scheduleCleanup(stream, Math.min(REPLAY_TTL_MS, remainingSignedTtlMs));
};

const failLiveTtsStream = (id, error) => {
  const stream = streams.get(id);
  if (!stream || stream.failed) {
    return;
  }
  stream.failed = true;
  stream.consumers.forEach((consumer) => {
    if (!consumer.destroyed) {
      consumer.destroy(error);
    }
  });
  cleanupStream(id);
};

const attachLiveTtsStream = ({ id, token, res }) => {
  const stream = streams.get(id);
  if (!stream || stream.expiresAt < Date.now()) {
    cleanupStream(id);
    res.status(404).json({ success: false, message: 'Audio stream not found' });
    return;
  }

  if (stream.token !== token) {
    res.status(403).json({ success: false, message: 'Invalid audio stream token' });
    return;
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Accept-Ranges', 'none');

  stream.attachCount += 1;

  log('live_tts_stream_attached', {
    streamId: id,
    playbackId: stream.playbackId,
    sequence: stream.sequence,
    attachCount: stream.attachCount,
    activeConsumers: stream.consumers.size,
    ended: stream.ended,
    bufferedByteLength: bufferedByteLength(stream),
    attachedSec: Number(((Date.now() - stream.createdAt) / 1000).toFixed(3)),
    hasFirstProviderChunk: Boolean(stream.firstChunkAt),
    firstProviderChunkSec: stream.firstChunkAt
      ? Number(((stream.firstChunkAt - stream.createdAt) / 1000).toFixed(3))
      : undefined
  });

  if (stream.ended) {
    log('live_tts_stream_replayed', {
      streamId: id,
      playbackId: stream.playbackId,
      sequence: stream.sequence,
      attachCount: stream.attachCount,
      attachedSec: Number(((Date.now() - stream.createdAt) / 1000).toFixed(3)),
      firstProviderChunkSec: stream.firstChunkAt
        ? Number(((stream.firstChunkAt - stream.createdAt) / 1000).toFixed(3))
        : undefined,
      ended: stream.ended,
      bufferedByteLength: bufferedByteLength(stream)
    });
  }

  const passthrough = new PassThrough();
  stream.consumers.add(passthrough);
  stream.chunks.forEach((chunk) => passthrough.write(chunk));
  if (stream.ended) {
    passthrough.end();
  }

  passthrough.on('close', () => {
    stream.consumers.delete(passthrough);
  });
  passthrough.on('error', (error) => {
    warn('Live TTS stream consumer failed', error.message);
  });
  passthrough.pipe(res);
};

module.exports = {
  appendLiveTtsStream,
  attachLiveTtsStream,
  createLiveTtsStream,
  failLiveTtsStream,
  finishLiveTtsStream
};
