const { enqueueSentence } = require('./ttsPipeline');
const { getPersonaVoice, getMessageById } = require('./memoryRepository');
const { splitIntoSpeechChunks } = require('./messageAssembler');
const { buildVoiceConfig, DEFAULT_LANGUAGE } = require('./voice');
const { warn } = require('./logger');
const { normalizeLanguageCode } = require('./languageSupport');

const handleTtsRequest = async ({ session, user }, payload, sendEvent) => {
  const messageId = payload?.messageId;
  const playbackId = payload?.playbackId;

  if (!messageId) {
    sendEvent('error', { type: 'missing_message_id', message: 'messageId is required' });
    return;
  }

  const message = await getMessageById(messageId);

  if (!message || message.session_id !== session.id) {
    sendEvent('error', { type: 'message_not_found', messageId });
    return;
  }

  if (message.role !== 'assistant') {
    sendEvent('error', { type: 'invalid_message_role', messageId });
    return;
  }

  const text = message.content?.text || '';
  if (!text.trim()) {
    sendEvent('error', { type: 'empty_message', messageId });
    return;
  }

  try {
    const playbackLanguage = normalizeLanguageCode(
      message.content?.metadata?.languageCode || session.language,
      DEFAULT_LANGUAGE
    );
    const personaVoice = await getPersonaVoice(
      session.personaId,
      playbackLanguage
    );
    const voiceConfig = buildVoiceConfig(personaVoice, playbackLanguage);
    const sentences = splitIntoSpeechChunks(text);

    if (!sentences.length) {
      sendEvent('error', { type: 'no_sentences', messageId });
      return;
    }

    const emit = (type, data = {}) => {
      sendEvent(type, { ...data, messageId, playbackId });
    };

    let previousText = '';
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index];
      const sequence = `${session.id}-${messageId}-${index}`;
      await enqueueSentence({
        sessionId: session.id,
        personaId: session.personaId,
        language: playbackLanguage,
        text: sentence,
        voiceConfig,
        sendEvent: emit,
        userId: user.id,
        sequence,
        previousText
      });
      previousText = `${previousText} ${sentence}`.replace(/\s+/g, ' ').trim();
    }
  } catch (error) {
    warn('On-demand TTS failed', error.message);
    sendEvent('error', { type: 'tts_error', message: error.message, messageId });
  }
};

module.exports = {
  handleTtsRequest
};
