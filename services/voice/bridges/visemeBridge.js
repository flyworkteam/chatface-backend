/**
 * visemeBridge — Üç viseme provider'ından (remote, elevenlabs, rhubarb) birini
 * seçer ve Arşiv vocab'ında `viseme.timeline` event'i yayar.
 *
 * Default provider: `remote` (mevcut services/ai/mouthCueService → viseme.fly-work.com).
 * Rhubarb sadece `VISEME_PROVIDER=rhubarb` setlenmişse, ffmpeg + Rhubarb binary
 * yerel mevcutsa çalışır.
 */

const { fetchMouthCues } = require('../../ai/mouthCueService');
const { warn } = require('../../ai/logger');

let rhubarbViseme = null;
let elevenLabsAlignment = null;

function loadRhubarb() {
  if (rhubarbViseme !== null) return rhubarbViseme;
  try {
    // rhubarbViseme modülü Arşiv'den taşındı. Ama Docker image'a Rhubarb binary
    // eklenmediyse import'u yine de bozulmuyor — sadece çağrıda fail eder.
    rhubarbViseme = require('../rhubarbViseme');
  } catch (_) {
    rhubarbViseme = false;
  }
  return rhubarbViseme || null;
}

function loadElevenLabsAlignment() {
  if (elevenLabsAlignment !== null) return elevenLabsAlignment;
  try {
    elevenLabsAlignment = require('../elevenLabsAlignment');
  } catch (_) {
    elevenLabsAlignment = false;
  }
  return elevenLabsAlignment || null;
}

function getProvider() {
  return String(process.env.VISEME_PROVIDER || 'remote').toLowerCase();
}

function isVisemeEnabled() {
  return String(process.env.VISEME_ENABLED || 'true').toLowerCase() === 'true';
}

function isVisemeBlockingEnabled() {
  return String(process.env.VISEME_BLOCKING || 'false').toLowerCase() === 'true';
}

function stabilizeVisemeTimeline(input) {
  const minGapSecRaw = Number(process.env.VISEME_MIN_GAP_SEC);
  const minGapSec = Number.isFinite(minGapSecRaw) ? minGapSecRaw : 0.04;
  const list = Array.isArray(input) ? input : [];
  const sorted = [...list]
    .map((v) => ({
      id: Number(v?.id || 0),
      time: Number(v?.time || v?.start || 0)
    }))
    .filter((v) => Number.isFinite(v.time) && v.time >= 0 && Number.isFinite(v.id))
    .sort((a, b) => a.time - b.time);

  const stabilized = [];
  for (const item of sorted) {
    const current = { id: item.id, time: Number(item.time.toFixed(3)) };
    const prev = stabilized[stabilized.length - 1];
    if (!prev) {
      stabilized.push(current);
      continue;
    }
    if (current.time - prev.time < minGapSec) continue;
    if (current.id === prev.id) continue;
    stabilized.push(current);
  }
  if (stabilized.length === 0) return [{ id: 0, time: 0 }];
  if (stabilized[0].time > 0) stabilized.unshift({ id: 0, time: 0 });
  return stabilized;
}

/**
 * @param {object} params
 * @param {(type, payload) => void} params.sendEvent
 * @param {string} params.utteranceId
 * @param {string} [params.audioUrl]   — remote provider için
 * @param {Buffer} [params.audioBuffer] — rhubarb için
 * @param {string} [params.text]        — elevenlabs alignment için
 * @param {string} [params.voiceId]
 * @param {string} [params.cacheKey]    — mouthCueService throttle key
 * @param {Array<{id, time}>} [params.preEnrichedMouthCues] — ttsBridge'den gelmişse
 */
async function emitTimeline({
  sendEvent,
  utteranceId,
  audioUrl,
  audioBuffer,
  text,
  voiceId,
  modelId,
  cacheKey,
  preEnrichedMouthCues
}) {
  if (!utteranceId) return;
  if (!isVisemeEnabled()) {
    sendEvent('viseme.unavailable', {
      utteranceId,
      reason: 'viseme_disabled'
    });
    return;
  }

  // ttsBridge cache hit'inde mouthCues hazır geliyor olabilir.
  if (Array.isArray(preEnrichedMouthCues) && preEnrichedMouthCues.length) {
    const stabilized = stabilizeVisemeTimeline(preEnrichedMouthCues);
    sendEvent('viseme.timeline', {
      utteranceId,
      visemes: stabilized,
      isLast: true,
      source: 'pre_enriched'
    });
    return;
  }

  const provider = getProvider();

  try {
    let raw = [];
    if (provider === 'elevenlabs') {
      const mod = loadElevenLabsAlignment();
      if (!mod || typeof mod.buildVisemesFromElevenLabsAlignment !== 'function') {
        sendEvent('viseme.unavailable', { utteranceId, reason: 'provider_module_missing' });
        return;
      }
      raw = await mod.buildVisemesFromElevenLabsAlignment({ text, voiceId, modelId });
    } else if (provider === 'rhubarb') {
      const mod = loadRhubarb();
      if (!mod || typeof mod.generateVisemesFromAudioBuffer !== 'function') {
        sendEvent('viseme.unavailable', { utteranceId, reason: 'rhubarb_unavailable' });
        return;
      }
      const result = audioBuffer
        ? await mod.generateVisemesFromAudioBuffer(audioBuffer, 'mp3')
        : audioUrl
          ? await mod.generateVisemesFromAudioUrl(audioUrl)
          : { visemes: [] };
      raw = Array.isArray(result?.visemes) ? result.visemes : [];
    } else {
      // default: remote (mouthCueService)
      if (!audioUrl) {
        sendEvent('viseme.unavailable', { utteranceId, reason: 'audio_url_missing' });
        return;
      }
      raw = await fetchMouthCues({ audioUrl, cacheKey: cacheKey || `voice-${utteranceId}` });
    }

    const visemes = stabilizeVisemeTimeline(raw);
    sendEvent('viseme.timeline', {
      utteranceId,
      visemes,
      isLast: true,
      source: provider
    });
  } catch (err) {
    warn('visemeBridge emitTimeline failed', err.message);
    sendEvent('viseme.unavailable', {
      utteranceId,
      reason: 'provider_error',
      message: err.message
    });
  }
}

module.exports = {
  emitTimeline,
  isVisemeBlockingEnabled,
  isVisemeEnabled,
  stabilizeVisemeTimeline,
  getProvider
};
