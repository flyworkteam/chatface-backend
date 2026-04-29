/**
 * aiPipelineBridge — STT final transcript'ini mevcut chatOrchestrator'a
 * teslim eder. Arşiv'in eski `aiPipeline.runAiPipeline` (echo/webhook/openai)
 * fonksiyonunun yerine geçer.
 *
 * Burada yaptığımız:
 *  1. handleSttTranscript çağrısını kuruyoruz; bu fonksiyon zaten echo guard,
 *     language validation, moderation, filler scheduling ve LLM streaming'i
 *     yönetiyor.
 *  2. handleSttTranscript içeride handleUserMessage'i çağırırken bir sendEvent
 *     callback'i bekliyor — biz Arşiv vocab'ına çevirip voice gateway'e
 *     iletiyoruz.
 *  3. assistant_done geldiğinde dönen `text`'i alıp ttsBridge'e veriyoruz
 *     (voice gateway tarafında handle edilir).
 *
 * Not: chatOrchestrator zaten mode='voice_call' iken otomatik TTS yapıyor
 * (shouldAutoTts=true). Voice gateway'i çift TTS'den korumak için orchestrator
 * çağrısında mode'u 'chat' olarak veriyoruz; TTS'i kendi tarafımızda
 * ttsBridge ile yönetiyoruz. Böylece cache + CDN + live stream pipeline'ı
 * yine çalışır ama voice gateway event vocab'ı ile birleşir.
 */

const { handleSttTranscript } = require('../../ai/chatOrchestrator');
const { warn } = require('../../ai/logger');
const { getFiller } = require('../../ai/fillerAudioService');
const { getGatewayErrorHint } = require('../../ai/thinkingVoices');
const { normalizeLanguageCode } = require('../../ai/languageSupport');

/**
 * @param {object} params
 * @param {object} params.session    — sessionService.formatSession() output (id, userId, personaId, activeMode, callLockedLanguage, language, ...)
 * @param {object} params.user       — { id, email }
 * @param {string} params.transcript — kullanıcı transcripti (final)
 * @param {string} params.utteranceId
 * @param {(type, payload) => void} params.sendEvent — Arşiv vocab event yayıcısı
 * @param {(text, meta) => Promise<void>} params.onAssistantText — TTS tetikleyici
 */
async function processFinalTranscript({
  session,
  user,
  transcript,
  utteranceId,
  language,
  sendEvent,
  onAssistantText
}) {
  let assistantText = '';
  let assistantMeta = null;
  // Savunma katmanı: chatOrchestrator'ın assistant_done payload'ında fullText
  // gelmezse delta'ları biriktirip kullanırız.
  const accumulatedDeltas = [];

  // Rejection / filler audio routing flag.
  // chatOrchestrator iki ayrı code path'te `tts_*` event'i yayar:
  //   1) Validation rejection → playRejectionVoice → tts_started/chunk/done
  //      (background queueBackgroundTask; assistant_done HİÇ fire etmez)
  //   2) Normal kabul → handleUserMessage içinde enqueueSentence per-sentence
  //      (assistant_done fire eder; voiceGateway ttsBridge ile yeniden çalar)
  //
  // (1)'i kullanıcıya ulaştırmak şart, (2)'yi suppress etmek şart (çift TTS
  // önlenir). Ayrım: stt_partial { suppressed: true } gelirse veya
  // assistant_done ASLA gelmemişse, sonraki tts_* event'leri rejection
  // audio'sudur ve forward edilir.
  let _rejectionPathActive = false;
  let _assistantDoneFired = false;
  let _rejectionTtsChunkSeq = 0;
  const _playedBridgeFillers = new Set();
  const _lockedSessionLanguage = normalizeLanguageCode(
    session?.callLockedLanguage || session?.language || language,
    'en'
  ) || 'en';

  const emitBridgeFiller = async ({ scenario, source }) => {
    if (!scenario || !session?.personaId || !session?.id) {
      return false;
    }
    const dedupeKey = `${scenario}:${source || 'bridge'}`;
    if (_playedBridgeFillers.has(dedupeKey)) {
      return false;
    }
    _playedBridgeFillers.add(dedupeKey);
    const filler = await getFiller({
      personaId: session.personaId,
      language: _lockedSessionLanguage,
      scenario,
      sessionId: session.id
    });
    if (!filler) {
      return false;
    }
    sendEvent('filler.audio', {
      playbackId: `bridge-${scenario}-${session.id}-${Date.now()}`,
      scenario,
      language: filler.language,
      audioUrl: filler.cdnUrl,
      cdnUrl: filler.cdnUrl,
      mouthCues: filler.mouthCues,
      durationMs: filler.durationMs,
      text: filler.text,
      source: source || 'bridge'
    });
    return true;
  };

  const forwardRejectionTts = (orchestratorType, data) => {
    if (orchestratorType === 'tts_started') {
      _rejectionTtsChunkSeq = 0;
      sendEvent('tts.start', {
        utteranceId,
        format: 'audio/mpeg',
        voice: data.voice,
        source: 'rejection'
      });
      return;
    }
    if (orchestratorType === 'tts_chunk') {
      sendEvent('tts.chunk', {
        utteranceId,
        chunkSeq: _rejectionTtsChunkSeq,
        audioUrl: data.audioUrl || null,
        audioBase64: data.audio || null,
        mouthCues: Array.isArray(data.mouthCues) ? data.mouthCues : [],
        isLast: false,
        source: 'rejection'
      });
      _rejectionTtsChunkSeq += 1;
      return;
    }
    if (orchestratorType === 'tts_done') {
      sendEvent('tts.chunk', {
        utteranceId,
        chunkSeq: _rejectionTtsChunkSeq,
        audioBase64: '',
        isLast: true,
        source: 'rejection'
      });
      sendEvent('tts.end', {
        utteranceId,
        mouthCues: Array.isArray(data.mouthCues) ? data.mouthCues : [],
        source: 'rejection'
      });
      return;
    }
    if (orchestratorType === 'tts_suppressed') {
      sendEvent('tts.stop', {
        utteranceId,
        reason: data.reason || 'suppressed',
        source: 'rejection'
      });
      return;
    }
  };

  // chatOrchestrator'ın `sendEvent`'i — Arşiv vocab'ına compat layer
  const orchestratorEmit = (type, data = {}) => {
    switch (type) {
      case 'ack':
        return;
      case 'typing':
        sendEvent('turn.state', {
          sessionId: session.id,
          state: 'thinking',
          reason: 'assistant_typing'
        });
        return;
      case 'assistant_delta':
        if (typeof data.delta === 'string' && data.delta.length) {
          accumulatedDeltas.push(data.delta);
        }
        sendEvent('ai.delta', {
          utteranceId,
          delta: data.delta
        });
        return;
      case 'assistant_done':
        _assistantDoneFired = true;
        // Önce payload'daki text, yoksa biriktirilen delta'lar.
        assistantText = data.fullText
          || data.text
          || accumulatedDeltas.join('')
          || assistantText;
        assistantMeta = {
          latencyMs: data.latencyMs,
          timings: data.timings || null
        };
        sendEvent('ai.response', {
          utteranceId,
          text: assistantText,
          source: 'orchestrator',
          latencyMs: data.latencyMs,
          timings: data.timings || null
        });
        return;
      case 'language_updated':
        sendEvent('language.updated', {
          sessionId: session.id,
          language: data.language
        });
        return;
      case 'filler_audio':
        sendEvent('filler.audio', data);
        return;
      case 'stt_partial':
        if (data?.metadata?.suppressed) {
          // Rejection path bu event'ten sonra başlıyor (handleSttTranscript
          // playRejectionVoice'i background queue'ya atıyor; tts_* event'leri
          // birazdan gelecek).
          _rejectionPathActive = true;
          sendEvent('stt.suppressed', {
            utteranceId,
            reason: data.metadata.reason || 'suppressed'
          });
        }
        return;
      case 'error':
        const normalizedCode = String(
          data.type || data.code || 'AI_PIPELINE_ERROR'
        ).toLowerCase();
        const localizedHint = getGatewayErrorHint({
          code: normalizedCode,
          language: _lockedSessionLanguage
        });
        sendEvent('error', {
          code: data.type || data.code || 'AI_PIPELINE_ERROR',
          message: localizedHint || data.message || 'AI pipeline error',
          retryable: false,
          stage: 'ai_pipeline'
        });
        if (normalizedCode === 'moderation') {
          emitBridgeFiller({
            scenario: 'cant_understand',
            source: 'moderation'
          }).catch((err) => warn('moderation filler emit failed', err.message));
        } else if (
          normalizedCode === 'llm_error' ||
          normalizedCode === 'ai_pipeline_error' ||
          normalizedCode === 'connection_retry_exhausted'
        ) {
          emitBridgeFiller({
            scenario: 'network_hiccup',
            source: 'pipeline_error'
          }).catch((err) => warn('pipeline filler emit failed', err.message));
        }
        return;
      default:
        // tts_started / tts_chunk / tts_done / tts_suppressed
        if (type.startsWith('tts_')) {
          if (_rejectionPathActive && !_assistantDoneFired) {
            // Rejection veya filler audio: kullanıcıya ulaşmalı.
            forwardRejectionTts(type, data);
          }
          // Normal kabul (assistant_done geldikten sonra orchestrator'ın
          // enqueueSentence cache pipeline'ı çalışıyor): voiceGateway zaten
          // ttsBridge.streamAssistantText ile kendi tts.* event'lerini
          // yayınlayacak; çift TTS önlemek için suppress.
          return;
        }
        return;
    }
  };

  try {
    // chatOrchestrator.handleSttTranscript STT final'ı handleUserMessage'a
    // promote eder. Mode'u 'voice_call' bırakıyoruz çünkü active_mode kontrolü
    // var; ama TTS'i kendi tarafımızda tutmak için ttsBridge'le ilgilenecek.
    //
    // NOT: handleUserMessage shouldAutoTts'i (mode === voice|video) true
    // yapıyor ve enqueueSentence çağırıyor. Bu cache pipeline'ını tetikler;
    // bizim voice gateway'imiz Arşiv vocab event'lerini aşağıdaki
    // ai.response → ttsBridge.streamAssistantText akışında üretir.
    //
    // Çift TTS'i önlemek için orchestratorEmit'te tts_* event'lerini
    // yutuyoruz; ama enqueueSentence yine cache'i sıcak tutuyor. Bu
    // gereksiz iş yapıyor — performans optimizasyonu için chatOrchestrator'a
    // `suppressTts` flag'i eklenebilir (bkz. takip notları).
    await handleSttTranscript(
      { session, user },
      {
        transcriptId: utteranceId,
        text: transcript,
        isFinal: true,
        metadata: {
          source: 'voice_gateway',
          languageCode: language || session.callLockedLanguage || session.language
        }
      },
      orchestratorEmit
    );
  } catch (err) {
    warn('aiPipelineBridge handleSttTranscript failed', err.message);
    emitBridgeFiller({
      scenario: 'network_hiccup',
      source: 'bridge_exception'
    }).catch((fillErr) => warn('bridge exception filler emit failed', fillErr.message));
    sendEvent('error', {
      code: 'AI_PIPELINE_ERROR',
      message: err.message,
      retryable: false,
      stage: 'ai_pipeline'
    });
    return;
  }

  if (assistantText && typeof onAssistantText === 'function') {
    try {
      await onAssistantText(assistantText, assistantMeta);
    } catch (err) {
      warn('aiPipelineBridge onAssistantText callback failed', err.message);
    }
    return { handled: true, rejected: false };
  }

  // assistant_done hiç fire etmedi — ya rejection, ya echo guard, ya da
  // başka bir suppression. Voice gateway turn.state'i listening'e
  // döndürebilsin diye sinyal döndürüyoruz.
  return { handled: false, rejected: _rejectionPathActive };
}

module.exports = {
  processFinalTranscript
};
