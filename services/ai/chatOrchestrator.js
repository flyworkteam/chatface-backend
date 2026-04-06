const SentenceAssembler = require('./messageAssembler');
const { buildContext } = require('./contextBuilder');
const {
  saveMessage,
  getPersonaVoice,
  recordUsage
} = require('./memoryRepository');
const { reviewText } = require('./moderationService');
const { enqueueSentence } = require('./ttsPipeline');
const { streamChatCompletion } = require('./geminiAdapter');
const { warn, log } = require('./logger');
const { buildVoiceConfig, DEFAULT_LANGUAGE } = require('./voice');
const { playThinkingVoice } = require('./thinkingVoices');
const { findEchoMatch, isAssistantSpeechActive } = require('./echoGuard');

const VALID_CONVERSATION_TYPES = new Set(['chat', 'voice_call', 'video_call']);
const VALID_CONVERSATION_STATUSES = new Set(['active', 'ended']);
const MAX_ATTACHMENTS = 5;
const INLINE_ATTACHMENT_LIMIT = 350 * 1024; // 350KB

const isVoiceMode = (mode) => mode === 'voice_call' || mode === 'video_call';

const getConversationEndText = (conversationType) => {
  if (conversationType === 'video_call') {
    return 'Video call ended';
  }
  if (conversationType === 'voice_call') {
    return 'Voice call ended';
  }
  return null;
};

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

  if (isConversationEndEvent) {
    const endText = getConversationEndText(conversationType);
    const savedMarker = await saveMessage({
      sessionId: session.id,
      role: 'system',
      content: {
        text: endText,
        displayText: endText,
        metadata
      }
    });

    sendEvent('ack', { messageId: payload.clientMessageId });
    sendEvent('conversation_marker', {
      messageId: savedMarker.id,
      sessionId: session.id,
      createdAt: savedMarker.createdAt,
      text: endText,
      metadata
    });
    return;
  }

  if (text) {
    const moderationResult = await reviewText(text);
    if (moderationResult.blocked) {
      sendEvent('error', { type: 'moderation', message: 'Message blocked' });
      return;
    }
  }

  await saveMessage({
    sessionId: session.id,
    role: 'user',
    content: { text, metadata, attachments }
  });

  sendEvent('ack', { messageId: payload.clientMessageId });
  sendEvent('typing', { state: 'assistant' });

  const sessionLanguage = session.language || DEFAULT_LANGUAGE;
  const sessionMode = session.mode || 'chat';
  const shouldAutoTts = isVoiceMode(sessionMode);

  // Run context build + persona voice lookup in parallel
  const [context, personaVoice] = await Promise.all([
    buildContext({
      sessionId: session.id,
      personaId: session.personaId,
      mode: sessionMode
    }),
    getPersonaVoice(session.personaId, sessionLanguage)
  ]);

  const voiceConfig = buildVoiceConfig(personaVoice, sessionLanguage);
  const responsePlaybackId = shouldAutoTts
    ? `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : null;

  // Fire thinking voice while LLM is generating (non-blocking)
  if (shouldAutoTts) {
    playThinkingVoice({
      session,
      personaId: session.personaId,
      language: sessionLanguage,
      voiceConfig,
      sendEvent,
      userId: user.id
    }).catch((err) => warn('Thinking voice failed', err.message));
  }

  const assembler = shouldAutoTts
    ? new SentenceAssembler({
      onSentenceComplete: (sentence) => {
        const sequence = `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        enqueueSentence({
          sessionId: session.id,
          personaId: session.personaId,
          language: sessionLanguage,
          text: sentence,
          voiceConfig,
          sendEvent,
          userId: user.id,
          sequence,
          playbackId: responsePlaybackId
        });
      }
    })
    : null;

  const startedAt = Date.now();

  try {
    const llmResult = await streamChatCompletion({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      mode: sessionMode,
      onDelta: (delta) => {
        if (delta) {
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

    const latencyMs = Date.now() - startedAt;

    // Send assistant_done immediately — don't wait for DB writes
    sendEvent('assistant_done', {
      latencyMs,
      messageId: null // will be resolved after save
    });

    // Fire-and-forget: save message + record usage in background
    Promise.all([
      saveMessage({
        sessionId: session.id,
        role: 'assistant',
        content: { text: llmResult.fullText }
      }),
      recordUsage({
        sessionId: session.id,
        userId: user.id,
        llmIn: Math.round(llmResult.tokensIn),
        llmOut: Math.round(llmResult.tokensOut),
        ttsChars: llmResult.fullText.length,
        latencyMs
      })
    ]).catch((err) => warn('Background save failed', err.message));

  } catch (error) {
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
    log('STT partial forwarded to client', {
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

  log('STT final promoted to user message', {
    sessionId: session.id,
    transcriptId,
    metadataKeys: Object.keys(payload.metadata || {})
  });

  const metadata = { ...(payload.metadata || {}) };
  metadata.source = metadata.source || (metadata.whisper ? 'whisper' : 'stt');
  if (typeof metadata.confidence === 'undefined' && metadata.whisper?.confidence !== undefined) {
    metadata.confidence = metadata.whisper.confidence;
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
