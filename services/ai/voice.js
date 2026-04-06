const DEFAULT_LANGUAGE = process.env.DEFAULT_AI_LANGUAGE || 'en';

const buildVoiceConfig = (voiceRow, language = DEFAULT_LANGUAGE) => {
  const voiceId = voiceRow?.elevenlabs_voice_id || process.env.ELEVENLABS_DEFAULT_VOICE;
  if (!voiceId) {
    throw new Error('No ElevenLabs voice configured for persona');
  }

  return {
    voiceId,
    language,
    settings: {
      stability: parseFloat(voiceRow?.stability ?? '0.5'),
      style: parseFloat(voiceRow?.style ?? '0.3')
    },
    sampleRate: parseInt(voiceRow?.sample_rate || '16000', 10)
  };
};

module.exports = {
  DEFAULT_LANGUAGE,
  buildVoiceConfig
};
