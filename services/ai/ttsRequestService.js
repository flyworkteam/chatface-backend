const { enqueueSentence } = require('./ttsPipeline');
const { getPersonaVoice, getMessageById } = require('./memoryRepository');
const { splitIntoSentences } = require('./messageAssembler');
const { buildVoiceConfig, DEFAULT_LANGUAGE } = require('./voice');
const { warn } = require('./logger');

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
    const personaVoice = await getPersonaVoice(
      session.personaId,
      session.language || DEFAULT_LANGUAGE
    );
    const voiceConfig = buildVoiceConfig(personaVoice, session.language || DEFAULT_LANGUAGE);
    const sentences = splitIntoSentences(text);

    if (!sentences.length) {
      sendEvent('error', { type: 'no_sentences', messageId });
      return;
    }

    const emit = (type, data = {}) => {
      sendEvent(type, { ...data, messageId, playbackId });
    };

    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index];
      const sequence = `${session.id}-${messageId}-${index}`;
      await enqueueSentence({
        sessionId: session.id,
        personaId: session.personaId,
        language: session.language || DEFAULT_LANGUAGE,
        text: sentence,
        voiceConfig,
        sendEvent: emit,
        userId: user.id,
        sequence
      });
    }
  } catch (error) {
    warn('On-demand TTS failed', error.message);
    sendEvent('error', { type: 'tts_error', message: error.message, messageId });
  }
};

module.exports = {
  handleTtsRequest
};
