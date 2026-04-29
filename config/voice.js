/**
 * Voice / video gateway config — env'leri tek noktadan okur.
 * services/voice/* modüllerinin process.env'e doğrudan dokunmasını
 * azaltmak için merkezîleştirildi.
 */

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envInt(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envString(name, fallback = null) {
  const raw = process.env[name];
  return raw && String(raw).trim() ? String(raw).trim() : fallback;
}

const VOICE_STREAMING_ENABLED = envBool('VOICE_STREAMING_ENABLED', false);
const VIDEO_CALL_ENABLED = envBool('VIDEO_CALL_ENABLED', false);
const VOICE_DEBUG_LOGS = envBool('VOICE_DEBUG_LOGS', false);
const VOICE_PERSIST_TO_CHAT = envBool('VOICE_PERSIST_TO_CHAT', false);
const VOICE_DEFAULT_LANGUAGE = envString('VOICE_DEFAULT_LANGUAGE', 'tr-TR');

const VOICE_AUDIO = {
  codec: envString('VOICE_AUDIO_CODEC', 'pcm16le'),
  sampleRate: envInt('VOICE_AUDIO_SAMPLE_RATE', 16000),
  channels: envInt('VOICE_AUDIO_CHANNELS', 1),
  frameMs: envInt('VOICE_AUDIO_FRAME_MS', 20)
};

const VOICE_VAD_SILENCE_MS = envInt('VOICE_VAD_SILENCE_MS', 900);

const STT_PROVIDER = envString('STT_PROVIDER', 'openai-realtime');

const VISEME_PROVIDER = envString('VISEME_PROVIDER', 'remote');
const VISEME_ENABLED = envBool('VISEME_ENABLED', true);
const VISEME_BLOCKING = envBool('VISEME_BLOCKING', false);

const WEBRTC_ENABLED = envBool('WEBRTC_ENABLED', false);

module.exports = {
  VOICE_STREAMING_ENABLED,
  VIDEO_CALL_ENABLED,
  VOICE_DEBUG_LOGS,
  VOICE_PERSIST_TO_CHAT,
  VOICE_DEFAULT_LANGUAGE,
  VOICE_AUDIO,
  VOICE_VAD_SILENCE_MS,
  STT_PROVIDER,
  VISEME_PROVIDER,
  VISEME_ENABLED,
  VISEME_BLOCKING,
  WEBRTC_ENABLED
};
