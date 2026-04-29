/**
 * ElevenLabs `with-timestamps` alignment endpoint'i ile
 * basit karakter→viseme ID dönüşümü. Türkçe karakterler dahil.
 */
const axios = require('axios');
const { VoiceStreamError } = require('./errors');
const { retryWithBackoff } = require('./retry');

function resolveElevenLabsConfig({ voiceId, modelId }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new VoiceStreamError(
      'ELEVENLABS_API_KEY_MISSING',
      'ELEVENLABS_API_KEY tanımlı değil',
      { recoverable: false }
    );
  }
  const resolvedVoiceId = voiceId
    || process.env.ELEVENLABS_DEFAULT_VOICE_ID
    || process.env.ELEVENLABS_DEFAULT_VOICE;
  if (!resolvedVoiceId) {
    throw new VoiceStreamError(
      'ELEVENLABS_VOICE_ID_MISSING',
      'voiceId bulunamadı',
      { recoverable: false }
    );
  }
  const resolvedModelId = modelId
    || process.env.ELEVENLABS_MODEL_ID
    || 'eleven_flash_v2_5';
  return { apiKey, resolvedVoiceId, resolvedModelId };
}

function charToVisemeId(ch) {
  const c = String(ch || '').toLowerCase();
  if (!c || /\s/.test(c) || /[.,!?;:'"(){}\[\]-]/.test(c)) return 0;
  if ('bmp'.includes(c)) return 8;
  if ('fv'.includes(c)) return 11;
  if ('l'.includes(c)) return 12;
  if ('szşçcj'.includes(c)) return 15;
  if ('kgq'.includes(c)) return 20;
  if ('uüw'.includes(c)) return 7;
  if ('oö'.includes(c)) return 6;
  if ('aeiıi'.includes(c)) return 2;
  if ('rtdnhy'.includes(c)) return 1;
  return 18;
}

function mapAlignmentToVisemes(alignment) {
  const chars = Array.isArray(alignment?.characters) ? alignment.characters : [];
  const starts = Array.isArray(alignment?.character_start_times_seconds)
    ? alignment.character_start_times_seconds
    : [];

  const visemes = [];
  let lastId = null;
  for (let i = 0; i < chars.length; i += 1) {
    const id = charToVisemeId(chars[i]);
    const time = Number(Number(starts[i] || 0).toFixed(3));
    if (id === lastId && visemes.length > 0) continue;
    visemes.push({ id, time });
    lastId = id;
  }
  return visemes;
}

async function buildVisemesFromElevenLabsAlignment({ text, voiceId, modelId }) {
  const safeText = String(text || '').trim();
  if (!safeText) return [];
  const { apiKey, resolvedVoiceId, resolvedModelId } = resolveElevenLabsConfig({ voiceId, modelId });
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}/with-timestamps`;

  const response = await retryWithBackoff(async () => {
    return axios.post(
      url,
      {
        text: safeText,
        model_id: resolvedModelId
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
  }, { retries: 1, baseDelayMs: 120 });

  const alignment = response.data?.alignment || response.data?.normalized_alignment || null;
  return mapAlignmentToVisemes(alignment);
}

module.exports = {
  buildVisemesFromElevenLabsAlignment
};
