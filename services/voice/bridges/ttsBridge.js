/**
 * ttsBridge — Voice gateway için Arşiv'in `tts.*` event vocab'ını
 * mevcut services/ai/ttsPipeline.enqueueSentence + liveTtsStreamService
 * pipeline'ına bağlar.
 *
 * Avantaj:
 *   - Voice/video aramaları BunnyCDN cache'inden, warm queue'dan, n8n TTS
 *     proxy'sinden (USE_N8N_TTS) faydalanır.
 *   - Live HTTP stream URL'i (/api/ai/tts/live/:id) ilk audio için
 *     emit edilir; mobile o URL'i çalmaya başlar, sonra `tts.chunk`
 *     base64 chunk'ları doldurur.
 *
 * Compat:
 *   - Mevcut `tts_started/tts_chunk/tts_done/tts_suppressed/error` event'leri
 *     Arşiv'in `tts.start/tts.chunk/tts.end/tts.stop` vocab'ına çevrilir.
 *   - mouthCues `tts_done` payload'ında geliyorsa visemeBridge'e iletilmek
 *     üzere onTtsCompleted callback'ine taşınır.
 */

const { enqueueSentence } = require('../../ai/ttsPipeline');
const { splitIntoSpeechChunks } = require('../../ai/messageAssembler');
const { buildVoiceConfig, DEFAULT_LANGUAGE } = require('../../ai/voice');
const { getPersonaVoice } = require('../../ai/memoryRepository');
const { warn } = require('../../ai/logger');

/**
 * Tek bir AI yanıtının tamamını sentence sentence ElevenLabs'e gönderir.
 *
 * @param {object} params
 * @param {{ id, userId, personaId, language, callLockedLanguage }} params.session
 * @param {string} params.text                — full assistant text
 * @param {string} params.utteranceId         — Arşiv vocab'ında kullanıcı tarafına gidecek utteranceId
 * @param {string} params.playbackId          — opsiyonel; verilmezse otomatik üretilir
 * @param {(type, payload) => void} params.sendEvent — Arşiv vocab event yayıcısı
 * @param {() => boolean} [params.shouldAbort] — barge-in için
 * @param {(audioBuffer, mouthCues) => Promise<void>} [params.onCompleted] — viseme tetiği
 */
async function streamAssistantText({
  session,
  text,
  utteranceId,
  playbackId,
  sendEvent,
  shouldAbort,
  onCompleted
}) {
  const language = session.callLockedLanguage || session.language || DEFAULT_LANGUAGE;
  const personaVoice = await getPersonaVoice(session.personaId, language);
  const voiceConfig = buildVoiceConfig(personaVoice, language);
  const sentences = splitIntoSpeechChunks(text);
  if (!sentences.length) {
    sendEvent('tts.end', { utteranceId, empty: true });
    return;
  }

  const ensuredPlaybackId = playbackId
    || `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let firstStartEmitted = false;
  let chunkSeq = 0;
  const collectedAudio = [];
  let collectedMouthCues = [];

  const aborted = () => typeof shouldAbort === 'function' && shouldAbort() === true;

  for (let index = 0; index < sentences.length; index += 1) {
    if (aborted()) {
      sendEvent('tts.stop', {
        utteranceId,
        reason: 'aborted'
      });
      return;
    }
    const sentence = sentences[index];
    const sequence = `${session.id}-${utteranceId}-${index}`;

    // ttsPipeline asenkron event yayıyor; biz onları toplayıp Arşiv vocab'ına çeviriyoruz.
    let chunkResolved;
    const chunkDone = new Promise((resolve) => { chunkResolved = resolve; });
    let sentenceCompleted = false;

    const bridgeEmit = (type, data = {}) => {
      if (type === 'tts_started') {
        if (!firstStartEmitted) {
          firstStartEmitted = true;
          sendEvent('tts.start', {
            utteranceId,
            playbackId: ensuredPlaybackId,
            format: 'audio/mpeg',
            voice: data.voice
          });
        }
        return;
      }
      if (type === 'tts_chunk') {
        const audioUrl = data.audioUrl || null;
        const audioBase64 = data.audio || null;
        sendEvent('tts.chunk', {
          utteranceId,
          playbackId: ensuredPlaybackId,
          chunkSeq,
          audioUrl,
          audioBase64,
          isLast: false
        });
        chunkSeq += 1;
        if (Array.isArray(data.mouthCues) && data.mouthCues.length) {
          collectedMouthCues = data.mouthCues;
        }
        return;
      }
      if (type === 'tts_done') {
        if (Array.isArray(data.mouthCues) && data.mouthCues.length) {
          collectedMouthCues = data.mouthCues;
        }
        sentenceCompleted = true;
        chunkResolved();
        return;
      }
      if (type === 'tts_suppressed') {
        sendEvent('tts.stop', {
          utteranceId,
          playbackId: ensuredPlaybackId,
          reason: data.reason || 'suppressed'
        });
        sentenceCompleted = true;
        chunkResolved();
        return;
      }
      if (type === 'error') {
        sendEvent('error', {
          code: data.type || 'TTS_ERROR',
          message: data.message || 'TTS error',
          retryable: false,
          stage: 'tts'
        });
        sentenceCompleted = true;
        chunkResolved();
        return;
      }
    };

    try {
      await enqueueSentence({
        sessionId: session.id,
        personaId: session.personaId,
        language,
        text: sentence,
        voiceConfig,
        sendEvent: bridgeEmit,
        userId: session.userId,
        sequence,
        playbackId: ensuredPlaybackId,
        previousText: collectedAudio.length
          ? sentences.slice(0, index).join(' ')
          : '',
        mode: session.activeMode || 'voice_call',
        // iOS AVPlayer chunked HTTP transfer encoding'li live stream URL'i
        // (`Content-Length` yok) sessizce reddediyor — kullanıcı ses duymuyor.
        // Live stream'i kapatıp tam audio buffer'ın inline base64'ünü
        // göndererek mobile `source=bytes` ile çalmaya zorluyoruz.
        // Ekstra ~200-300ms latency ama iOS uyumlu.
        // Override için TTS_VOICE_LIVE_STREAM=true env'i.
        liveStream: String(process.env.TTS_VOICE_LIVE_STREAM || 'false').toLowerCase() === 'true',
        turnStartedAt: Date.now(),
        shouldAbort
      });
    } catch (err) {
      warn('ttsBridge.enqueueSentence failed', err.message);
      sendEvent('error', {
        code: 'TTS_PIPELINE_ERROR',
        message: err.message,
        retryable: false,
        stage: 'tts'
      });
      return;
    }

    if (!sentenceCompleted) {
      // ttsPipeline bazen tts_done'u yutabiliyor; max 30 sn timeout.
      await Promise.race([
        chunkDone,
        new Promise((resolve) => setTimeout(resolve, 30000))
      ]);
    }
  }

  // Tüm cümleler bittiğinde explicit isLast marker
  sendEvent('tts.chunk', {
    utteranceId,
    playbackId: ensuredPlaybackId,
    chunkSeq,
    audioBase64: '',
    isLast: true
  });
  sendEvent('tts.end', {
    utteranceId,
    playbackId: ensuredPlaybackId,
    mouthCues: collectedMouthCues
  });

  if (typeof onCompleted === 'function') {
    try {
      await onCompleted({
        audioBuffer: null, // ttsPipeline buffer'ı bize aktarmıyor; visemeBridge audioUrl üzerinden enrich eder
        mouthCues: collectedMouthCues,
        text,
        playbackId: ensuredPlaybackId
      });
    } catch (err) {
      warn('ttsBridge onCompleted callback failed', err.message);
    }
  }
}

module.exports = {
  streamAssistantText
};
