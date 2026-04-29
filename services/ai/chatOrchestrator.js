/**
 * chatOrchestrator.js — v2
 *
 * Rewrite v2 changes:
 *  - Per-turn mode is authoritative: we trust `payload.conversationType` over
 *    the session row's `active_mode` for the current turn, but reconcile.
 *  - Locked-call language: when a call is active, STT/LLM/TTS all use
 *    `session.callLockedLanguage`. Chat mode continues to auto-detect.
 *  - Echo guard is now applied to BOTH partials and finals.
 *  - `validateTranscript` is called with audio-ms-received + assistant-active
 *    signals so the hallucination filter can do short-clip rejection.
 *  - Filler audio is scheduled from the pre-rendered CDN cache on
 *    cant_understand / wrong_language / network_hiccup — falls back to
 *    live TTS only if the cache misses.
 *
 * See REWRITE_ARCHITECTURE.md §4, §5, §7, §8.
 */

const SentenceAssembler = require('./messageAssembler');
const { buildContext } = require('./contextBuilder');
const {
  saveMessage,
  getPersonaVoice,
  recordUsage
} = require('./memoryRepository');
const { reviewText } = require('./moderationService');
const { enqueueSentence } = require('./ttsPipeline');
const { warn, log, debug } = require('./logger');
const { buildVoiceConfig, DEFAULT_LANGUAGE } = require('./voice');
const {
  scheduleThinkingVoice,
  cancelThinkingVoice,
  playRejectionVoice
} = require('./thinkingVoices');
const { findEchoMatch, isAssistantSpeechActive } = require('./echoGuard');
const { updateSessionLanguage, getCallState } = require('./sessionService');
const { resolveUserLanguage, validateTranscript } = require('./languageResolution');
const { normalizeLanguageCode } = require('./languageSupport');
const { getFiller } = require('./fillerAudioService');

// Phase 2: n8n LLM adapter (used when USE_N8N_LLM=true)
const USE_N8N_LLM = process.env.USE_N8N_LLM === 'true';
const { streamChatCompletion: streamChatCompletionDirect } = require('./openaiAdapter');
const { streamChatCompletionViaN8n } = require('./n8nLlmAdapter');
const streamChatCompletion = USE_N8N_LLM ? streamChatCompletionViaN8n : streamChatCompletionDirect;

// Phase 4: async n8n analytics fire
const {
  fireWebhook,
  validateNodeInternalBaseUrl
} = require('../../config/n8n');

const VALID_CONVERSATION_TYPES = new Set(['chat', 'voice_call', 'video_call']);
const VALID_CONVERSATION_STATUSES = new Set(['active', 'ended']);
const MAX_ATTACHMENTS = 5;
const INLINE_ATTACHMENT_LIMIT = 350 * 1024; // 350KB
const USE_N8N_MODERATION_ASYNC = process.env.USE_N8N_MODERATION_ASYNC === 'true';

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

const elapsedSec = (startedAt) =>
  startedAt ? Number(((Date.now() - startedAt) / 1000).toFixed(3)) : undefined;

const buildModerationLogPayload = ({
  session,
  user,
  sessionMode,
  text,
  metadata,
  moderationResult
}) => ({
  sessionId: session.id,
  userId: user.id,
  transcriptId: metadata.transcriptId,
  mode: sessionMode,
  textPreview: previewText(text),
  reason: moderationResult.reason,
  flaggedCategories: moderationResult.flaggedCategories || [],
  categoryScores: moderationResult.categoryScores || {}
});

const buildModerationErrorPayload = (moderationResult) => ({
  type: 'moderation',
  code: 'moderation',
  message: 'Message blocked',
  reason: moderationResult.reason
});

const queueBackgroundTask = (label, task) => {
  Promise.resolve()
    .then(task)
    .catch((error) => warn(label, error.message));
};

// ── Filler audio dispatch ────────────────────────────────────────────────────
// Serve pre-rendered filler clips from CDN when we need to stall or reject.
// Falls back to live TTS (via existing playRejectionVoice / scheduleThinkingVoice)
// when the cache misses.

const playFillerClip = async ({ session, personaId, language, scenario, sendEvent }) => {
  const filler = await getFiller({
    personaId,
    language,
    scenario,
    sessionId: session.id
  });
  if (!filler) {
    return false;
  }
  const playbackId = `filler-${scenario}-${session.id}-${Date.now()}`;
  debug('Serving pre-rendered filler clip', {
    sessionId: session.id,
    scenario,
    language,
    cdnUrl: filler.cdnUrl,
    durationMs: filler.durationMs
  });
  sendEvent('filler_audio', {
    playbackId,
    scenario,
    language: filler.language,
    cdnUrl: filler.cdnUrl,
    mouthCues: filler.mouthCues,
    durationMs: filler.durationMs,
    text: filler.text
  });
  return true;
};

// ── Derive authoritative per-turn mode + language ────────────────────────────

const deriveTurnContext = ({ session, payload, metadata }) => {
  // Priority order for mode:
  //   1. Per-turn conversationType (payload)
  //   2. Per-turn conversationType (metadata)
  //   3. session.activeMode
  //   4. session.preferredMode
  //   5. 'chat'
  const activeModeHint = session.activeMode || session.preferredMode || session.mode || 'chat';
  const defaultMode = normalizeSessionMode(activeModeHint);
  const { conversationType, conversationStatus } = resolveConversationMetadata({
    payload,
    metadata,
    defaultType: defaultMode
  });

  // Language policy:
  //   - If we're in a voice/video call: use callLockedLanguage (authoritative)
  //   - Otherwise: use session.language as the working state for detection
  const lockedLanguage = normalizeLanguageCode(session.callLockedLanguage, null);
  const sessionLanguage = normalizeLanguageCode(session.language, DEFAULT_LANGUAGE);
  const isLocked = isVoiceMode(conversationType) && Boolean(lockedLanguage);
  const workingLanguage = isLocked ? lockedLanguage : sessionLanguage;

  return {
    conversationType,
    conversationStatus,
    lockedLanguage,
    workingLanguage,
    isLocked,
    isVoiceTurn: isVoiceMode(conversationType)
  };
};

// ───────────────────────────────────────────────────────────────────────────────
// handleUserMessage — per-turn LLM + TTS orchestration
// ───────────────────────────────────────────────────────────────────────────────

const handleUserMessage = async (
  { session, user },
  payload,
  sendEvent,
  options = {}
) => {
  const turnStartedAt = Date.now();
  const text = payload.text?.trim();

  const turnTimings = { turnStartMs: 0 };

  const metadata = {
    ...options.metadata
  };

  const turnCtx = deriveTurnContext({ session, payload, metadata });
  const {
    conversationType,
    conversationStatus,
    lockedLanguage,
    isLocked,
    isVoiceTurn
  } = turnCtx;
  let { workingLanguage } = turnCtx;

  metadata.conversationType = conversationType;
  metadata.conversationStatus = conversationStatus;

  const isCallConversation = isVoiceMode(conversationType);
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

  // ── Language resolution ────────────────────────────────────────────────
  // For voice/video turns with a locked language, we trust the lock. For
  // chat turns, run detection and persist on change.
  let languageResolution;
  if (isLocked) {
    languageResolution = {
      language: lockedLanguage,
      confidence: 1,
      source: 'call_lock',
      shouldSwitch: false
    };
  } else if (text) {
    languageResolution = resolveUserLanguage({
      text,
      currentLanguage: workingLanguage
    });
  } else {
    languageResolution = {
      language: workingLanguage,
      confidence: 0,
      source: 'fallback',
      shouldSwitch: false
    };
  }

  const resolvedLanguage = normalizeLanguageCode(languageResolution.language, workingLanguage);
  const shouldPersistLanguage =
    !isLocked && resolvedLanguage && resolvedLanguage !== workingLanguage;

  if (resolvedLanguage) {
    metadata.languageCode = resolvedLanguage;
    metadata.languageConfidence = languageResolution.confidence;
    metadata.languageSource = languageResolution.source;
  }

  if (shouldPersistLanguage) {
    await updateSessionLanguage(session.id, resolvedLanguage);
    session.language = resolvedLanguage;
    workingLanguage = resolvedLanguage;
    sendEvent('language_updated', {
      language: resolvedLanguage,
      sessionId: session.id
    });
    log('Session conversation language updated', {
      sessionId: session.id,
      userId: user.id,
      to: resolvedLanguage,
      source: languageResolution.source,
      confidence: languageResolution.confidence
    });
  }

  sendEvent('typing', { state: 'assistant' });

  const activeLanguage = normalizeLanguageCode(workingLanguage, DEFAULT_LANGUAGE);
  const shouldAutoTts = isVoiceTurn;
  const userContent = { text, metadata, attachments };

  // ── Moderation ──────────────────────────────────────────────────────────
  let moderationResult = { blocked: false };
  let moderationBlocked = false;

  const moderationPromise = text && !USE_N8N_MODERATION_ASYNC
    ? reviewText(text)
        .then((result) => {
          turnTimings.moderationDoneMs = Date.now() - turnStartedAt;
          moderationResult = result;
          if (result.blocked) {
            moderationBlocked = true;
            cancelThinkingVoice(session.id, sendEvent);
            log('Moderation flagged message (async)', {
              sessionId: session.id,
              userId: user.id,
              turnSec: elapsedSec(turnStartedAt),
              reason: result.reason
            });
          } else if (result.softWarn) {
            log('Moderation soft-warn (allow)', {
              sessionId: session.id,
              userId: user.id,
              turnSec: elapsedSec(turnStartedAt),
              reason: result.reason,
              flaggedCategories: result.flaggedCategories || [],
              categoryScores: result.categoryScores || {},
              hardBlockThreshold: result.hardBlockThreshold
            });
          }
          return result;
        })
        .catch((err) => {
          warn('Moderation check failed, allowing request', err.message);
          return { blocked: false, degraded: true };
        })
    : Promise.resolve({ blocked: false, via: USE_N8N_MODERATION_ASYNC ? 'n8n_async' : 'disabled' });

  if (text && USE_N8N_MODERATION_ASYNC) {
    const callbackBase = validateNodeInternalBaseUrl().normalized;
    fireWebhook('moderationCheck', {
      turnId: payload.clientMessageId || metadata.transcriptId || null,
      sessionId: session.id,
      userId: user.id,
      mode: conversationType,
      language: activeLanguage,
      text,
      openAiKey: process.env.OPENAI_API_KEY || '',
      callbackUrl: callbackBase
        ? `${callbackBase}/api/n8n/moderation-result`
        : null,
      timestamp: new Date().toISOString()
    });
  }

  // ── Context + voice config ──────────────────────────────────────────────
  const prepStartedAt = Date.now();

  const [context, personaVoice] = await Promise.all([
    buildContext({
      sessionId: session.id,
      userId: session.userId,
      personaId: session.personaId,
      mode: conversationType,
      conversationLanguage: activeLanguage,
      lockedLanguage: isLocked ? lockedLanguage : null,
      pendingMessages: [{ role: 'user', content: userContent }]
    }),
    shouldAutoTts
      ? getPersonaVoice(session.personaId, activeLanguage)
      : Promise.resolve(null)
  ]);

  turnTimings.prepDoneMs = Date.now() - turnStartedAt;

  if (shouldAutoTts) {
    log('Voice turn pre-LLM prep completed', {
      sessionId: session.id,
      userId: user.id,
      stageSec: elapsedSec(prepStartedAt),
      turnSec: elapsedSec(turnStartedAt),
      language: activeLanguage
    });
  }

  // Persist user message in background
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
    queueBackgroundTask('Filler / thinking voice failed', async () => {
      // Prefer pre-rendered CDN filler for "thinking_short"; fall back to
      // live TTS thinking voice if the cache misses.
      const served = await playFillerClip({
        session,
        personaId: session.personaId,
        language: activeLanguage,
        scenario: 'thinking_short',
        sendEvent
      }).catch(() => false);
      if (served) {
        return;
      }
      scheduleThinkingVoice({
        session,
        personaId: session.personaId,
        language: activeLanguage,
        voiceConfig,
        sendEvent,
        userId: user.id
      });
    });
  }

  const assembler = shouldAutoTts
    ? (() => {
        let previousSpeechText = '';
        return new SentenceAssembler({
          onSentenceComplete: (sentence) => {
            if (moderationBlocked) return;
            cancelThinkingVoice(session.id, sendEvent);
            const sequence = `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const previousText = previousSpeechText;
            previousSpeechText = `${previousSpeechText} ${sentence}`.replace(/\s+/g, ' ').trim();
            if (!turnTimings.firstSentenceEmittedMs) {
              turnTimings.firstSentenceEmittedMs = Date.now() - turnStartedAt;
            }
            enqueueSentence({
              sessionId: session.id,
              personaId: session.personaId,
              language: activeLanguage,
              text: sentence,
              voiceConfig,
              sendEvent: (type, data = {}) => {
                if (!turnTimings.firstAudioMs && type === 'tts_chunk' && (data.audioUrl || data.audio)) {
                  turnTimings.firstAudioMs = Date.now() - turnStartedAt;
                }
                sendEvent(type, data);
              },
              userId: user.id,
              sequence,
              playbackId: responsePlaybackId,
              previousText,
              mode: conversationType,
              liveStream: true,
              turnStartedAt
            });
          }
        });
      })()
    : null;

  const llmStartedAt = Date.now();
  turnTimings.llmStartMs = llmStartedAt - turnStartedAt;
  let emittedFirstDelta = false;
  let networkHiccupFired = false;
  // If the LLM is slow (>1.5s to first token for voice turns), drop a
  // "network_hiccup" filler so the call doesn't feel dead.
  const hiccupTimer = shouldAutoTts
    ? setTimeout(() => {
        if (emittedFirstDelta || networkHiccupFired) return;
        networkHiccupFired = true;
        playFillerClip({
          session,
          personaId: session.personaId,
          language: activeLanguage,
          scenario: 'network_hiccup',
          sendEvent
        }).catch(() => {
          /* swallow: fallback is the regular thinking voice which already fires */
        });
      }, 1500)
    : null;
  if (hiccupTimer?.unref) {
    hiccupTimer.unref();
  }

  try {
    if (shouldAutoTts) {
      log('Voice turn LLM request started', {
        sessionId: session.id,
        userId: user.id,
        turnSec: elapsedSec(turnStartedAt),
        via: USE_N8N_LLM ? 'n8n' : 'direct'
      });
    }

    const llmResult = await streamChatCompletion({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      mode: conversationType,
      analyticsContext: {
        sessionId: session.id,
        userId: user.id,
        personaId: session.personaId,
        language: activeLanguage
      },
      onDelta: (delta) => {
        if (!delta || moderationBlocked) return;
        if (!emittedFirstDelta) {
          emittedFirstDelta = true;
          if (hiccupTimer) {
            clearTimeout(hiccupTimer);
          }
          turnTimings.llmFirstTokenMs = Date.now() - turnStartedAt;
          cancelThinkingVoice(session.id, sendEvent);
          log('First assistant delta emitted', {
            sessionId: session.id,
            userId: user.id,
            stageSec: elapsedSec(llmStartedAt),
            turnSec: elapsedSec(turnStartedAt),
            latencyMs: Date.now() - llmStartedAt
          });
        }
        sendEvent('assistant_delta', { delta });
        if (assembler) {
          assembler.append(delta);
        }
      }
    });

    if (assembler) {
      assembler.flush();
    }
    if (hiccupTimer) {
      clearTimeout(hiccupTimer);
    }
    cancelThinkingVoice(session.id, sendEvent);

    await moderationPromise;

    if (moderationBlocked) {
      log('Moderation blocked user message', buildModerationLogPayload({
        session,
        user,
        sessionMode: conversationType,
        text,
        metadata,
        moderationResult
      }));
      sendEvent('error', buildModerationErrorPayload(moderationResult));
      return;
    }

    const latencyMs = Date.now() - llmStartedAt;
    turnTimings.turnEndMs = Date.now() - turnStartedAt;

    const moderationTimingMs = Number.isFinite(turnTimings.moderationDoneMs)
      ? turnTimings.moderationDoneMs
      : 0;

    sendEvent('assistant_done', {
      latencyMs,
      messageId: null,
      // Voice gateway aiPipelineBridge bu field'ı okuyup ttsBridge'e veriyor.
      // /realtime client'ları (chat) field'ı zararsızca ignore eder.
      fullText: llmResult.fullText,
      timings: {
        prepMs: turnTimings.prepDoneMs ?? null,
        llmStartMs: turnTimings.llmStartMs ?? null,
        llmFirstTokenMs: turnTimings.llmFirstTokenMs ?? null,
        firstSentenceMs: turnTimings.firstSentenceEmittedMs ?? null,
        firstAudioMs: turnTimings.firstAudioMs ?? null,
        moderationMs: moderationTimingMs,
        totalMs: turnTimings.turnEndMs ?? null
      }
    });

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

    fireWebhook('aiTurnAnalytics', {
      sessionId: session.id,
      userId: user.id,
      personaId: session.personaId,
      mode: conversationType,
      language: activeLanguage,
      lockedLanguage: isLocked ? lockedLanguage : null,
      llmIn: Math.round(llmResult.tokensIn),
      llmOut: Math.round(llmResult.tokensOut),
      ttsChars: llmResult.fullText.length,
      latencyMs,
      timings: {
        prepMs: turnTimings.prepDoneMs ?? null,
        llmFirstTokenMs: turnTimings.llmFirstTokenMs ?? null,
        firstSentenceMs: turnTimings.firstSentenceEmittedMs ?? null,
        firstAudioMs: turnTimings.firstAudioMs ?? null,
        moderationMs: moderationTimingMs,
        totalMs: turnTimings.turnEndMs ?? null
      },
      viaN8nLlm: USE_N8N_LLM,
      viaN8nModerationAsync: USE_N8N_MODERATION_ASYNC,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (hiccupTimer) {
      clearTimeout(hiccupTimer);
    }
    cancelThinkingVoice(session.id, sendEvent);
    warn('Chat orchestrator failed', error.message);

    // Sesli oturumda hata olduysa "network_hiccup" filler çalıp kullanıcıyı
    // sessiz bir ekranla baş başa bırakma.
    if (shouldAutoTts) {
      queueBackgroundTask('Error filler failed', () =>
        playFillerClip({
          session,
          personaId: session.personaId,
          language: activeLanguage,
          scenario: 'network_hiccup',
          sendEvent
        })
      );
    }
    sendEvent('error', { type: 'llm_error', message: error.message });
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// handleSttTranscript — partial + final STT flow
// ───────────────────────────────────────────────────────────────────────────────

const handleSttTranscript = async ({ session, user }, payload, sendEvent) => {
  // Pull the authoritative call state fresh per transcript — the row on
  // `session` may be stale if the caller hasn't re-fetched post-call-start.
  const callState = await getCallState(session.id).catch(() => null);
  const activeMode = callState?.activeMode || session.activeMode || session.mode || 'chat';
  const lockedLanguage = normalizeLanguageCode(
    callState?.lockedLanguage || session.callLockedLanguage,
    null
  );

  log('STT inbound orchestrator', {
    sessionId: session.id,
    userId: user.id,
    activeMode,
    lockedLanguage,
    transcriptId: payload.transcriptId || payload.clientMessageId,
    isFinal: payload.isFinal !== false,
    textLength: payload.text?.trim()?.length || 0,
    audioMs: payload.metadata?.audioMsReceived ?? null
  });

  // STT is only meaningful when a call is active. If the row says chat,
  // it means either we haven't called /call/start yet or the call ended.
  if (activeMode === 'chat' && !lockedLanguage) {
    warn('STT payload ignored — no active call', {
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
  const duringAssistantSpeech = isAssistantSpeechActive({ sessionId: session.id });

  if (duringAssistantSpeech) {
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
      metadata: { suppressed: true, reason: 'assistant_speaking' }
    });
    return;
  }

  // Echo guard now runs on BOTH partials and finals.
  const echoMatch = findEchoMatch({ sessionId: session.id, transcript: text });
  if (echoMatch) {
    log('STT transcript suppressed as AI echo', {
      sessionId: session.id,
      userId: user.id,
      transcriptId,
      isFinal,
      textPreview: preview,
      matchedPreview: previewText(echoMatch.matchedText),
      tokenOverlap: echoMatch.tokenOverlap,
      bigramSimilarity: echoMatch.bigramSimilarity,
      windowOverlap: echoMatch.windowOverlap,
      ageMs: echoMatch.ageMs,
      reason: echoMatch.reason,
      playbackId: echoMatch.playbackId
    });
    sendEvent('stt_partial', {
      transcriptId,
      text: '',
      metadata: {
        suppressed: true,
        reason: 'assistant_echo',
        echoReason: echoMatch.reason
      }
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

  const audioMsReceived = Number(payload.metadata?.audioMsReceived);

  const validation = validateTranscript({
    text,
    metadata: payload.metadata,
    currentLanguage: lockedLanguage || session.language,
    lockedLanguage,
    audioMsReceived: Number.isFinite(audioMsReceived) ? audioMsReceived : null,
    duringAssistantSpeech
  });

  if (!validation.accepted) {
    log('STT final suppressed after validation', {
      sessionId: session.id,
      userId: user.id,
      transcriptId,
      textPreview: preview,
      reason: validation.reason,
      confidence: validation.confidence,
      audioMsReceived: Number.isFinite(audioMsReceived) ? audioMsReceived : null,
      resolvedLanguage: validation.resolution?.language,
      lockedLanguage
    });
    sendEvent('stt_partial', {
      transcriptId,
      text: '',
      metadata: { suppressed: true, reason: validation.reason }
    });

    // Sesli geri bildirim: önce pre-rendered filler'ı dene, sonra live TTS.
    queueBackgroundTask('STT rejection voice failed', async () => {
      const activeLanguage = normalizeLanguageCode(
        lockedLanguage || session.language,
        DEFAULT_LANGUAGE
      );
      const scenario = validation.reason === 'locked_language_mismatch'
        ? 'wrong_language'
        : 'cant_understand';
      const served = await playFillerClip({
        session,
        personaId: session.personaId,
        language: activeLanguage,
        scenario,
        sendEvent
      }).catch(() => false);
      if (served) {
        return;
      }
      const personaVoice = await getPersonaVoice(session.personaId, activeLanguage);
      if (!personaVoice) return;
      const voiceCfg = buildVoiceConfig(personaVoice, activeLanguage);
      playRejectionVoice({
        session,
        personaId: session.personaId,
        language: activeLanguage,
        voiceConfig: voiceCfg,
        sendEvent,
        userId: user.id,
        reason: validation.reason
      });
    });

    return;
  }

  log('STT final promoted to user message', {
    sessionId: session.id,
    transcriptId,
    metadataKeys: Object.keys(payload.metadata || {}),
    sttSec: payload.metadata?.latencyMs
      ? Number((payload.metadata.latencyMs / 1000).toFixed(3))
      : undefined
  });

  const metadata = { ...(payload.metadata || {}) };
  metadata.source = metadata.source || (metadata.openaiStt ? 'openai_stt' : 'stt');
  metadata.conversationType = activeMode;
  if (typeof metadata.confidence === 'undefined' && metadata.openaiStt?.confidence !== undefined) {
    metadata.confidence = metadata.openaiStt.confidence;
  }
  if (validation.resolution?.language) {
    metadata.languageCode = validation.resolution.language;
    metadata.languageConfidence = validation.resolution.confidence;
    metadata.languageSource = validation.resolution.source;
  }
  if (lockedLanguage) {
    metadata.lockedLanguage = lockedLanguage;
  }

  // Promote to user turn. Patch the session snapshot with fresh call state
  // so handleUserMessage picks the right mode/language.
  const liveSession = {
    ...session,
    activeMode,
    callLockedLanguage: lockedLanguage
  };

  await handleUserMessage(
    { session: liveSession, user },
    {
      ...payload,
      text,
      clientMessageId: transcriptId ?? payload.clientMessageId,
      conversationType: activeMode,
      conversationStatus: 'active'
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
  buildModerationErrorPayload,
  buildModerationLogPayload,
  handleUserMessage,
  handleSttTranscript
};
