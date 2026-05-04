const DEFAULT_LANGUAGE = process.env.DEFAULT_AI_LANGUAGE || 'en';

const parseOptionalFloat = (value) => {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const parseOptionalBoolean = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
};

const buildVoiceConfig = (voiceRow, language = DEFAULT_LANGUAGE) => {
  const voiceId = voiceRow?.elevenlabs_voice_id;
  if (!voiceId) {
    throw new Error('No ElevenLabs voice configured for persona');
  }

  const settings = {
    stability: parseOptionalFloat(voiceRow?.stability),
    similarity_boost: parseOptionalFloat(voiceRow?.similarity_boost),
    style: parseOptionalFloat(voiceRow?.style),
    use_speaker_boost: parseOptionalBoolean(voiceRow?.use_speaker_boost)
  };

  return {
    voiceId,
    language,
    settings: Object.fromEntries(
      Object.entries(settings).filter(([, value]) => value !== undefined)
    ),
    sampleRate: parseInt(voiceRow?.sample_rate || '16000', 10)
  };
};

module.exports = {
  DEFAULT_LANGUAGE,
  buildVoiceConfig
};
