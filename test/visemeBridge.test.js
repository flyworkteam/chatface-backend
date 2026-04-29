const test = require('node:test');
const assert = require('node:assert/strict');

const bridgePath = require.resolve('../services/voice/bridges/visemeBridge');
const mouthCuePath = require.resolve('../services/ai/mouthCueService');
const loggerPath = require.resolve('../services/ai/logger');
const elevenAlignmentPath = require.resolve('../services/voice/elevenLabsAlignment');
const rhubarbPath = require.resolve('../services/voice/rhubarbViseme');

const loadBridgeWithMocks = ({
  fetchMouthCues = async () => [],
  elevenlabsVisemes = async () => [],
  rhubarbVisemes = async () => ({ visemes: [] })
} = {}) => {
  delete require.cache[bridgePath];
  require.cache[mouthCuePath] = {
    id: mouthCuePath,
    filename: mouthCuePath,
    loaded: true,
    exports: { fetchMouthCues }
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn: () => {} }
  };
  require.cache[elevenAlignmentPath] = {
    id: elevenAlignmentPath,
    filename: elevenAlignmentPath,
    loaded: true,
    exports: { buildVisemesFromElevenLabsAlignment: elevenlabsVisemes }
  };
  require.cache[rhubarbPath] = {
    id: rhubarbPath,
    filename: rhubarbPath,
    loaded: true,
    exports: { generateVisemesFromAudioBuffer: rhubarbVisemes }
  };
  return require(bridgePath);
};

test('visemeBridge uses remote provider by default and stabilizes timeline', async () => {
  const touched = [bridgePath, mouthCuePath, loggerPath, elevenAlignmentPath, rhubarbPath];
  const originals = new Map(touched.map((path) => [path, require.cache[path]]));
  const previousProvider = process.env.VISEME_PROVIDER;
  const previousEnabled = process.env.VISEME_ENABLED;
  try {
    process.env.VISEME_PROVIDER = 'remote';
    process.env.VISEME_ENABLED = 'true';

    const visemeBridge = loadBridgeWithMocks({
      fetchMouthCues: async () => [
        { id: 3, time: 0.09 },
        { id: 3, time: 0.1 },
        { id: 5, time: 0.25 }
      ]
    });

    const events = [];
    await visemeBridge.emitTimeline({
      sendEvent: (type, payload) => events.push({ type, payload }),
      utteranceId: 'utt-1',
      audioUrl: 'https://cdn.example/audio.mp3'
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'viseme.timeline');
    assert.equal(events[0].payload.source, 'remote');
    assert.deepEqual(events[0].payload.visemes[0], { id: 0, time: 0 });
  } finally {
    if (previousProvider === undefined) delete process.env.VISEME_PROVIDER;
    else process.env.VISEME_PROVIDER = previousProvider;
    if (previousEnabled === undefined) delete process.env.VISEME_ENABLED;
    else process.env.VISEME_ENABLED = previousEnabled;
    touched.forEach((path) => {
      const original = originals.get(path);
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    });
  }
});

test('visemeBridge switches provider for elevenlabs and rhubarb', async () => {
  const touched = [bridgePath, mouthCuePath, loggerPath, elevenAlignmentPath, rhubarbPath];
  const originals = new Map(touched.map((path) => [path, require.cache[path]]));
  const previousProvider = process.env.VISEME_PROVIDER;
  const previousEnabled = process.env.VISEME_ENABLED;
  try {
    process.env.VISEME_ENABLED = 'true';

    const events = [];
    const visemeBridge = loadBridgeWithMocks({
      elevenlabsVisemes: async () => [{ id: 1, time: 0.04 }, { id: 2, time: 0.14 }],
      rhubarbVisemes: async () => ({ visemes: [{ id: 6, time: 0.06 }, { id: 7, time: 0.2 }] })
    });

    process.env.VISEME_PROVIDER = 'elevenlabs';
    await visemeBridge.emitTimeline({
      sendEvent: (type, payload) => events.push({ type, payload }),
      utteranceId: 'utt-eleven',
      text: 'Merhaba'
    });

    process.env.VISEME_PROVIDER = 'rhubarb';
    await visemeBridge.emitTimeline({
      sendEvent: (type, payload) => events.push({ type, payload }),
      utteranceId: 'utt-rhubarb',
      audioBuffer: Buffer.from([1, 2, 3])
    });

    const eleven = events.find((entry) => entry.payload.source === 'elevenlabs');
    const rhubarb = events.find((entry) => entry.payload.source === 'rhubarb');
    assert.ok(eleven, 'elevenlabs timeline should be emitted');
    assert.ok(rhubarb, 'rhubarb timeline should be emitted');
  } finally {
    if (previousProvider === undefined) delete process.env.VISEME_PROVIDER;
    else process.env.VISEME_PROVIDER = previousProvider;
    if (previousEnabled === undefined) delete process.env.VISEME_ENABLED;
    else process.env.VISEME_ENABLED = previousEnabled;
    touched.forEach((path) => {
      const original = originals.get(path);
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    });
  }
});
