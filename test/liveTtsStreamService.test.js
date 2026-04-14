const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const freshLiveTtsStreamService = () => {
  delete require.cache[require.resolve('../services/ai/liveTtsStreamService')];
  return require('../services/ai/liveTtsStreamService');
};

const {
  appendLiveTtsStream,
  attachLiveTtsStream,
  createLiveTtsStream,
  finishLiveTtsStream
} = freshLiveTtsStreamService();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.body = [];
    this.finishedPromise = new Promise((resolve) => {
      this.on('finish', resolve);
    });
  }

  setHeader(key, value) {
    this.headers[key] = value;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(payload) {
    this.jsonPayload = payload;
    this.end();
  }

  _write(chunk, _encoding, callback) {
    this.body.push(Buffer.from(chunk));
    callback();
  }
}

test('live TTS stream writes appended chunks before provider completion', async () => {
  const stream = createLiveTtsStream({
    sessionId: 'session-1',
    userId: 'user-1',
    sequence: 'seq-1',
    playbackId: 'playback-1'
  });
  const url = new URL(`http://localhost${stream.url}`);
  const response = new FakeResponse();

  attachLiveTtsStream({
    id: stream.id,
    token: url.searchParams.get('token'),
    res: response
  });

  appendLiveTtsStream(stream.id, Buffer.from('first'));
  appendLiveTtsStream(stream.id, Buffer.from('second'));
  finishLiveTtsStream(stream.id);
  await response.finishedPromise;

  assert.equal(response.headers['Content-Type'], 'audio/mpeg');
  assert.equal(Buffer.concat(response.body).toString(), 'firstsecond');
});

test('live TTS stream replays buffered audio for AVPlayer repeat attaches', async () => {
  const stream = createLiveTtsStream({
    sessionId: 'session-2',
    userId: 'user-1',
    sequence: 'seq-2',
    playbackId: 'playback-2'
  });
  const url = new URL(`http://localhost${stream.url}`);

  appendLiveTtsStream(stream.id, Buffer.from('cached'));
  finishLiveTtsStream(stream.id);

  const firstResponse = new FakeResponse();
  attachLiveTtsStream({
    id: stream.id,
    token: url.searchParams.get('token'),
    res: firstResponse
  });
  await firstResponse.finishedPromise;

  const secondResponse = new FakeResponse();
  attachLiveTtsStream({
    id: stream.id,
    token: url.searchParams.get('token'),
    res: secondResponse
  });
  await secondResponse.finishedPromise;

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(Buffer.concat(firstResponse.body).toString(), 'cached');
  assert.equal(Buffer.concat(secondResponse.body).toString(), 'cached');
});

test('live TTS stream retains finished audio for configured replay window', async () => {
  const originalReplayTtl = process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS;
  const originalStreamTtl = process.env.TTS_LIVE_STREAM_TTL_MS;
  process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS = '80';
  process.env.TTS_LIVE_STREAM_TTL_MS = '1000';
  const service = freshLiveTtsStreamService();

  const stream = service.createLiveTtsStream({
    sessionId: 'session-3',
    userId: 'user-1',
    sequence: 'seq-3',
    playbackId: 'playback-3'
  });
  const url = new URL(`http://localhost${stream.url}`);

  service.appendLiveTtsStream(stream.id, Buffer.from('late-cache'));
  service.finishLiveTtsStream(stream.id);
  await wait(25);

  const response = new FakeResponse();
  service.attachLiveTtsStream({
    id: stream.id,
    token: url.searchParams.get('token'),
    res: response
  });
  await response.finishedPromise;

  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.concat(response.body).toString(), 'late-cache');

  if (originalReplayTtl === undefined) delete process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS;
  else process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS = originalReplayTtl;
  if (originalStreamTtl === undefined) delete process.env.TTS_LIVE_STREAM_TTL_MS;
  else process.env.TTS_LIVE_STREAM_TTL_MS = originalStreamTtl;
});

test('live TTS stream returns 404 after replay retention expires', async () => {
  const originalReplayTtl = process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS;
  const originalStreamTtl = process.env.TTS_LIVE_STREAM_TTL_MS;
  process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS = '20';
  process.env.TTS_LIVE_STREAM_TTL_MS = '1000';
  const service = freshLiveTtsStreamService();

  const stream = service.createLiveTtsStream({
    sessionId: 'session-4',
    userId: 'user-1',
    sequence: 'seq-4',
    playbackId: 'playback-4'
  });
  const url = new URL(`http://localhost${stream.url}`);

  service.appendLiveTtsStream(stream.id, Buffer.from('expired'));
  service.finishLiveTtsStream(stream.id);
  await wait(40);

  const response = new FakeResponse();
  service.attachLiveTtsStream({
    id: stream.id,
    token: url.searchParams.get('token'),
    res: response
  });
  await response.finishedPromise;

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.jsonPayload, {
    success: false,
    message: 'Audio stream not found'
  });

  if (originalReplayTtl === undefined) delete process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS;
  else process.env.TTS_LIVE_STREAM_REPLAY_TTL_MS = originalReplayTtl;
  if (originalStreamTtl === undefined) delete process.env.TTS_LIVE_STREAM_TTL_MS;
  else process.env.TTS_LIVE_STREAM_TTL_MS = originalStreamTtl;
});
