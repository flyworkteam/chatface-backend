/**
 * Rhubarb subprocess wrapper. Sadece VISEME_PROVIDER=rhubarb iken kullanılır.
 * Production Docker image'ında ffmpeg + rhubarb binary bulunmuyorsa visemeBridge
 * sessizce diğer provider'a düşer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const TEMP_DIR = path.join(os.tmpdir(), 'chatface-voice-viseme');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Rhubarb → Microsoft Viseme map
const RHUBARB_MAP = {
  A: 2, B: 8, C: 18, D: 1, E: 2, F: 11, G: 20,
  H: 1, I: 2, J: 18, K: 20, L: 12, M: 8, N: 1,
  O: 6, P: 8, Q: 20, R: 1, S: 15, T: 1, U: 7,
  V: 11, W: 7, X: 0, Y: 1, Z: 15
};

function getRhubarbPath() {
  return process.env.VISEME_RHUBARB_BIN || '/opt/rhubarb/rhubarb';
}

function getFfmpegPath() {
  return process.env.VISEME_FFMPEG_BIN || 'ffmpeg';
}

function execFilePromise(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err) => (err ? reject(err) : resolve()));
  });
}

function mapRhubarbToVisemes(raw) {
  const mouthCues = Array.isArray(raw?.mouthCues) ? raw.mouthCues : [];
  return mouthCues.map((cue) => ({
    id: RHUBARB_MAP[cue.value] ?? 0,
    time: Number(Number(cue.start || 0).toFixed(3))
  }));
}

async function runVisemePipeline(inputPath, id) {
  const wavPath = path.join(TEMP_DIR, `${id}.wav`);
  const jsonPath = path.join(TEMP_DIR, `${id}.json`);
  try {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`viseme input missing before ffmpeg: ${inputPath}`);
    }
    await execFilePromise(getFfmpegPath(), ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', wavPath]);
    await execFilePromise(getRhubarbPath(), [wavPath, '-f', 'json', '-o', jsonPath]);
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return { visemes: mapRhubarbToVisemes(raw) };
  } finally {
    [wavPath, jsonPath].forEach((p) => {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    });
  }
}

async function generateVisemesFromAudioUrl(audioUrl) {
  if (!audioUrl) {
    const err = new Error('audioUrl is required');
    err.statusCode = 400;
    throw err;
  }

  const id = randomUUID();
  const inputPath = path.join(TEMP_DIR, `${id}.input`);
  try {
    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 20000
    });
    fs.writeFileSync(inputPath, Buffer.from(response.data));
    return await runVisemePipeline(inputPath, id);
  } finally {
    if (fs.existsSync(inputPath)) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
  }
}

async function generateVisemesFromAudioBuffer(audioBuffer, inputExt = 'mp3') {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { visemes: [] };
  }
  const id = randomUUID();
  const safeExt = String(inputExt || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
  const inputPath = path.join(TEMP_DIR, `${id}.${safeExt}`);
  try {
    fs.writeFileSync(inputPath, audioBuffer);
    return await runVisemePipeline(inputPath, id);
  } finally {
    if (fs.existsSync(inputPath)) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
  }
}

module.exports = {
  generateVisemesFromAudioUrl,
  generateVisemesFromAudioBuffer
};
