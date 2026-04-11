const SentenceAssembler = require('./messageAssembler');
const { buildContext } = require('./contextBuilder');
const {
  saveMessage,
  getPersonaVoice,
  recordUsage
} = require('./memoryRepository');
const { reviewText } = require('./moderationService');
const { enqueueSentence } = require('./ttsPipeline');
const { streamChatCompletion } = require('./openaiAdapter');
const { warn, log, debug } = require('./logger');
const { buildVoiceConfig, DEFAULT_LANGUAGE } = require('./voice');
const { scheduleThinkingVoice, cancelThinkingVoice } = require('./thinkingVoices');
const { findEchoMatch, isAssistantSpeechActive } = require('./echoGuard');
const { updateSessionLanguage } = require('./sessionService');
const { resolveUserLanguage, validateTranscript } = require('./languageResolution');
const { normalizeLanguageCode } = require('./languageSupport');

const VALID_CONVERSATION_TYPES = new Set(['chat', 'voice_call', 'video_call']);
const VALID_CONVERSATION_STATUSES = new Set(['active', 'ended']);
const MAX_ATTACHMENTS = 5;
const INLINE_ATTACHMENT_LIMIT = 350 * 1024; // 350KB

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const resolveConversationMetadata = ({ payload, metadata, defaultType = 'chat' }) => {
  const payloadType = payload?.conversationType;
  const metadataType = metadata?.conversationType;
  const payloadStatus = payload?.conversationStatus;
  const metadataStatus = metadata?.conversationStatus;
  const fallbackType = VALID_CONVERSATION_TYPES.has(defaultType) ? defaultType : 'chat';

  const conversationType = VALID_CONVERSATION_TYPES.has(payloadType)
    ? payloadType
    : VALID_CONVERSATION_TYPES.has(metadataType)
      ? metadataType
      : fallbackType;

  const conversationStatus = VALID_CONVERSATION_STATUSES.has(payloadStatus)
    ? payloadStatus
    : VALID_CONVERSATION_STATUSES.has(metadataStatus)
      ? metadataStatus
      : 'active';

  return {
    conversationType,
    conversationStatus
  };
};

const normalizeSessionMode = (mode = 'chat') => {
  if (mode === 'voice') {
    return 'voice_call';
  }
  if (mode === 'video') {
    return 'video_call';
  }
  return VALID_CONVERSATION_TYPES.has(mode) ? mode : 'chat';
};

const normalizeAttachment = (attachment) => {
  if (!attachment || typeof attachment !== 'object') {
    return null;
  }

  const url = typeof attachment.url === 'string' ? attachment.url.trim() : '';
  if (!url) {
    return null;
  }

  const normalized = {
    url,
    thumbnailUrl: typeof attachment.thumbnailUrl === 'string' ? attachment.thumbnailUrl.trim() : undefined,
    width: Number.isFinite(Number(attachment.width)) ? Number(attachment.width) : undefined,
    height: Number.isFinite(Number(attachment.height)) ? Number(attachment.height) : undefined,
    mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
    sizeBytes: Number.isFinite(Number(attachment.sizeBytes)) ? Number(attachment.sizeBytes) : undefined
  };

  const inline = typeof attachment.inlineBase64 === 'string' ? attachment.inlineBase64.trim() : '';
  if (inline) {
    const inlineBytes = Buffer.byteLength(inline, 'base64');
    if (inlineBytes <= INLINE_ATTACHMENT_LIMIT) {
      normalized.inlineBase64 = inline;
    }
  }

  return normalized;
};

const sanitizeAttachmentsForStorage = (attachments = []) => {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .slice(0, MAX_ATTACHMENTS)
    .map(normalizeAttachment)
    .filter(Boolean);
};

const previewText = (text, limit = 120) => {
  if (!text) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

const queueBackgroundTask = (label, task) => {
  Promise.resolve()
    .then(task)
    .catch((error) => warn(label, error.message));
};

const handleUserMessage = async (
  { session, user },
  payload,
  sendEvent,
  options = {}
) => {
  const text = payload.text?.trim();

  const metadata = {
    ...options.metadata
  };
  const sessionMode = session.mode || 'chat';
  const isLockedCallLanguage = isVoiceMode(sessionMode);

  const defaultMode = normalizeSessionMode(session.mode);
  const { conversationType, conversationStatus } = resolveConversationMetadata({
    payload,
    metadata,
    defaultType: defaultMode
  });
  metadata.conversationType = conversationType;
  metadata.conversationStatus = conversationStatus;

  const isCallConversation = conversationType === 'voice_call' || conversationType === 'video_call';
  const isConversationEndEvent = isCallConversation && conversationStatus === 'ended';
  const isActiveCallConversation = isCallConversation && conversationStatus === 'active';

  const attachments = sanitizeAttachmentsForStorage(payload.attachments);
  const hasContent = Boolean(text) || attachments.length > 0;

  if (!hasContent && !isConversationEndEvent) {
    sendEvent('error', { type: 'empty_message', message: 'Message text or attachment required' });
    return;
  }

  if (options.source) {
    metadata.source = options.source;
  }
  if (options.transcriptId) {
    metadata.transcriptId = options.transcriptId;
  }

  sendEvent('ack', { messageId: payload.clientMessageId });

  if (isConversationEndEvent) {
    return;
  }

  const sessionLanguage = normalizeLanguageCode(session.language, DEFAULT_LANGUAGE);
  const languageResolution = isLockedCallLanguage
    ? {
        language: sessionLanguage,
        confidence: 1,
        source: 'manual_lock',
        shouldSwitch: false
      }
    : text
      ? resolveUserLanguage({ text, currentLanguage: sessionLanguage })
      : {
          language: sessionLanguage,
          confidence: 0,
          source: 'fallback',
          shouldSwitch: false
        };
  const resolvedLanguage = normalizeLanguageCode(languageResolution.language, sessionLanguage);
  const shouldPersistLanguage = !isLockedCallLanguage && resolvedLanguage && resolvedLanguage !== sessionLanguage;

  if (resolvedLanguage) {
    metadata.languageCode = resolvedLanguage;
    metadata.languageConfidence = languageResolution.confidence;
    metadata.languageSource = languageResolution.source;
  }

  if (shouldPersistLanguage) {
    await updateSessionLanguage(session.id, resolvedLanguage);
    session.language = resolvedLanguage;
    sendEvent('language_updated', {
      language: resolvedLanguage,
      sessionId: session.id
    });
    log('Session conversation language updated', {
      sessionId: session.id,
      userId: user.id,
      from: sessionLanguage,
      to: resolvedLanguage,
      source: languageResolution.source,
      confidence: languageResolution.confidence
    });
  }

  sendEvent('typing', { state: 'assistant' });

  const activeLanguage = normalizeLanguageCode(session.language, DEFAULT_LANGUAGE);
  const shouldAutoTts = isVoiceMode(sessionMode);
  const userContent = { text, metadata, attachments };
  const moderationPromise = text
    ? reviewText(text)
    : Promise.resolve({ blocked: false });

  const [moderationResult, context, personaVoice] = await Promise.all([
    moderationPromise,
    buildContext({
      sessionId: session.id,
      personaId: session.personaId,
      mode: sessionMode,
      conversationLanguage: activeLanguage,
      pendingMessages: [{ role: 'user', content: userContent }]
    }),
    shouldAutoTts
      ? getPersonaVoice(session.personaId, activeLanguage)
      : Promise.resolve(null)
  ]);

  if (moderationResult.blocked) {
    sendEvent('error', { type: 'moderation', message: 'Message blocked' });
    return;
  }

  queueBackgroundTask('Failed to persist user message', async () => {
    await saveMessage({
      sessionId: session.id,
      role: 'user',
      content: userContent,
      historyVisible: !isActiveCallConversation
    });
  });

  const voiceConfig = shouldAutoTts
    ? buildVoiceConfig(personaVoice, activeLanguage)
    : null;
  const responsePlaybackId = shouldAutoTts
    ? `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : null;

  if (shouldAutoTts) {
    queueBackgroundTask('Thinking voice failed', async () => {
      scheduleThinkingVoice({
      session,
      personaId: session.personaId,
      language: activeLanguage,
      voiceConfig: voiceConfig,
      sendEvent,
      userId: user.id
      });
    });
  }

  const assembler = shouldAutoTts
    ? new SentenceAssembler({
      onSentenceComplete: (sentence) => {
        cancelThinkingVoice(session.id, sendEvent);
        const sequence = `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        enqueueSentence({
          sessionId: session.id,
          personaId: session.personaId,
          language: activeLanguage,
          text: sentence,
          voiceConfig: voiceConfig,
          sendEvent,
          userId: user.id,
          sequence,
          playbackId: responsePlaybackId
        });
      }
    })
    : null;

  const startedAt = Date.now();
  let emittedFirstDelta = false;

  try {
    const llmResult = await streamChatCompletion({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      mode: sessionMode,
      onDelta: (delta) => {
        if (delta) {
          if (!emittedFirstDelta) {
            emittedFirstDelta = true;
            cancelThinkingVoice(session.id, sendEvent);
            log('First assistant delta emitted', {
              sessionId: session.id,
              userId: user.id,
              latencyMs: Date.now() - startedAt
            });
          }
          sendEvent('assistant_delta', { delta });
          if (assembler) {
            assembler.append(delta);
          }
        }
      }
    });

    if (assembler) {
      assembler.flush();
    }
    cancelThinkingVoice(session.id, sendEvent);

    const latencyMs = Date.now() - startedAt;

    // Send assistant_done immediately — don't wait for DB writes
    sendEvent('assistant_done', {
      latencyMs,
      messageId: null // will be resolved after save
    });

    // Fire-and-forget: save message + record usage in background
    queueBackgroundTask('Background assistant persistence failed', async () => {
      await Promise.all([
        saveMessage({
          sessionId: session.id,
          role: 'assistant',
          content: {
            text: llmResult.fullText,
            metadata: {
              conversationType,
              conversationStatus,
              languageCode: activeLanguage
            }
          },
          historyVisible: !isActiveCallConversation
        }),
        recordUsage({
          sessionId: session.id,
          userId: user.id,
          llmIn: Math.round(llmResult.tokensIn),
          llmOut: Math.round(llmResult.tokensOut),
          ttsChars: llmResult.fullText.length,
          latencyMs
        })
      ]);
    });
  } catch (error) {
    cancelThinkingVoice(session.id, sendEvent);
    warn('Chat orchestrator failed', error.message);
    sendEvent('error', { type: 'llm_error', message: error.message });
  }
};

const handleSttTranscript = async ({ session, user }, payload, sendEvent) => {
  log('STT inbound orchestrator', {
    sessionId: session.id,
    userId: user.id,
    mode: session.mode,
    transcriptId: payload.transcriptId || payload.clientMessageId,
    isFinal: payload.isFinal !== false,
    textLength: payload.text?.trim()?.length || 0
  });

  if (session.mode === 'chat') {
    warn('STT payload ignored in chat-only session', {
      sessionId: session.id,
      userId: user.id
    });
    sendEvent('error', { message: 'STT is only available for voice or video sessions.' });
    return;
  }

  const text = payload.text?.trim();
  if (!text) {
    warn('STT payload missing text', {
      sessionId: session.id,
      userId: user.id,
      transcriptId: payload.transcriptId || payload.clientMessageId
    });
    return;
  }

  const transcriptId = payload.transcriptId || payload.clientMessageId;
  const isFinal = payload.isFinal !== false;
  const preview = previewText(text);

  if (isAssistantSpeechActive({ sessionId: session.id })) {
    log('STT transcript suppressed while assistant speech is active', {
      sessionId: session.id,
      userId: user.id,
      transcriptId,
      isFinal,
      textPreview: preview
    });
    sendEvent('stt_partial', {
      transcriptId,
      text: '',
      metadata: {
        suppressed: true,
        reason: 'assistant_speaking',
      },
    });
    return;
  }

  const echoMatch = isFinal
    ? findEchoMatch({ sessionId: session.id, transcript: text })
    : null;
  if (echoMatch) {
    log('STT transcript suppressed as AI echo', {
      sessionId: session.id,
      userId: user.id,
      transcriptId,
      textPreview: preview,
      matchedPreview: previewText(echoMatch.matchedText),
      tokenOverlap: echoMatch.tokenOverlap,
      bigramSimilarity: echoMatch.bigramSimilarity,
      ageMs: echoMatch.ageMs,
      playbackId: echoMatch.playbackId,
    });
    sendEvent('stt_partial', {
      transcriptId,
      text: '',
      metadata: {
        suppressed: true,
        reason: 'assistant_echo',
      },
    });
    return;
  }

  log('STT transcript received', {
    sessionId: session.id,
    userId: user.id,
    transcriptId,
    isFinal,
    textPreview: preview,
    textLength: text.length
  });

  if (!isFinal) {
    debug('STT partial forwarded to client', {
      sessionId: session.id,
      transcriptId,
      textPreview: preview
    });
    sendEvent('stt_partial', {
      transcriptId,
      text
    });
    return;
  }

  const validation = validateTranscript({
    text,
    metadata: payload.metadata,
    currentLanguage: session.language,
    lockedLanguage: isVoiceMode(session.mode) ? session.language : null
  });

  if (!validation.accepted) {
    log('STT final suppressed after validation', {
      sessionId: session.id,
      userId: user.id,
      transcriptId,
      textPreview: preview,
      reason: validation.reason,
      confidence: validation.confidence,
      resolvedLanguage: validation.resolution?.language
    });
    sendEvent('stt_partial', {
      transcriptId,
      text: '',
      metadata: {
        suppressed: true,
        reason: validation.reason
      }
    });
    return;
  }

  log('STT final promoted to user message', {
    sessionId: session.id,
    transcriptId,
    metadataKeys: Object.keys(payload.metadata || {})
  });

  const metadata = { ...(payload.metadata || {}) };
  metadata.source = metadata.source || (metadata.openaiStt ? 'openai_stt' : 'stt');
  if (typeof metadata.confidence === 'undefined' && metadata.openaiStt?.confidence !== undefined) {
    metadata.confidence = metadata.openaiStt.confidence;
  }
  if (validation.resolution?.language) {
    metadata.languageCode = validation.resolution.language;
    metadata.languageConfidence = validation.resolution.confidence;
    metadata.languageSource = validation.resolution.source;
  }

  await handleUserMessage(
    { session, user },
    {
      ...payload,
      text,
      clientMessageId: transcriptId ?? payload.clientMessageId
    },
    sendEvent,
    {
      source: metadata.source || 'stt',
      transcriptId,
      metadata
    }
  );

  log('STT final handled as user message', {
    sessionId: session.id,
    userId: user.id,
    transcriptId
  });
};

module.exports = {
  handleUserMessage,
  handleSttTranscript
};
