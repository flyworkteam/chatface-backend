/**
 * POST /api/ai/viseme  { audioUrl } → { visemes: [...] }
 *
 * Üç provider'ı seçim yapan basit HTTP wrapper. Default `remote` provider
 * mevcut services/ai/mouthCueService'e (viseme.fly-work.com) yönlendirir;
 * istemci hâlâ mevcut response shape'ini bekleyebilir.
 */
const express = require('express');
const { fetchMouthCues } = require('../ai/mouthCueService');
const { stabilizeVisemeTimeline, getProvider } = require('./bridges/visemeBridge');

let rhubarb = null;
function loadRhubarb() {
  if (rhubarb !== null) return rhubarb;
  try {
    rhubarb = require('./rhubarbViseme');
  } catch (_) {
    rhubarb = false;
  }
  return rhubarb || null;
}

function createVisemeRouter() {
  const router = express.Router();

  router.post('/viseme', async (req, res) => {
    const { audioUrl } = req.body || {};
    if (!audioUrl) {
      return res.status(400).json({ error: 'audioUrl is required' });
    }

    const provider = getProvider();
    try {
      let raw = [];
      if (provider === 'rhubarb') {
        const mod = loadRhubarb();
        if (!mod) {
          return res.status(503).json({ error: 'rhubarb provider unavailable' });
        }
        const result = await mod.generateVisemesFromAudioUrl(audioUrl);
        raw = Array.isArray(result?.visemes) ? result.visemes : [];
      } else {
        // remote (default) — mevcut mouthCueService cache + backoff'lu çağrı
        raw = await fetchMouthCues({ audioUrl, cacheKey: `http-${audioUrl}` });
      }
      const visemes = stabilizeVisemeTimeline(raw);
      return res.json({ visemes });
    } catch (err) {
      if (err?.statusCode === 400) {
        return res.status(400).json({ error: 'audioUrl is required' });
      }
      console.error('[VOICE_HTTP] viseme failed', err);
      return res.status(500).json({ error: 'viseme generation failed' });
    }
  });

  return router;
}

module.exports = {
  createVisemeRouter
};
