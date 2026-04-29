const SttProvider = require('./SttProvider');
const { VoiceStreamError } = require('../errors');
const sttStreamService = require('../../ai/sttStreamService');

/**
 * Voice gateway için OpenAI Realtime STT köprüsü.
 * Mevcut services/ai/sttStreamService.js'i sarar; voice gateway'e
 * provider arayüzünü konuşur (`partial`, `final` event'leri).
 *
 * sttStreamService aslında bir "session başına tek socket" servisidir;
 * bu provider ona session bilgisini iletip onTranscript callback'inden
 * gelen `stt_transcript` payload'larını Arşiv vocab'ına (`final` event)
 * çevirir. Partial'lar `sendEvent('stt_partial', …)` üzerinden alınır.
 */
class OpenAiRealtimeSttProvider extends SttProvider {
  constructor(config = {}) {
    super(config);
    this.session = null;
    this.user = null;
    this.activeUtteranceId = null;
    this.started = false;
  }

  /**
   * @param {{ sessionId, userId, conversationId, language, sessionRow, userRow }} ctx
   *   sessionRow/userRow: sttStreamService'in beklediği orjinal session/user objeleri.
   */
  async startSession(ctx = {}) {
    const sessionRow = ctx.sessionRow;
    const userRow = ctx.userRow;
    if (!sessionRow || !sessionRow.id) {
      throw new VoiceStreamError(
        'SESSION_ROW_MISSING',
        'OpenAiRealtimeSttProvider startSession: sessionRow gerekli',
        { recoverable: false }
      );
    }
    if (!userRow || !userRow.id) {
      throw new VoiceStreamError(
        'USER_ROW_MISSING',
        'OpenAiRealtimeSttProvider startSession: userRow gerekli',
        { recoverable: false }
      );
    }

    this.session = sessionRow;
    this.user = userRow;

    const sendEvent = (type, data = {}) => {
      // sttStreamService partial event'lerini doğrudan WS'e yazıyordu;
      // burada provider event'lerine çeviriyoruz.
      if (type === 'stt_partial') {
        this.emit('partial', {
          utteranceId: data?.transcriptId || this.activeUtteranceId || 'utterance',
          language: this.config.language || 'tr-TR',
          transcript: data?.text || ''
        });
        return;
      }
      if (type === 'stt_stream_ready') {
        // bilgi amaçlı; yutuyoruz.
        return;
      }
      if (type === 'error') {
        this.emit('error', new VoiceStreamError(
          data?.type || 'STT_ERROR',
          data?.message || 'STT error',
          { recoverable: data?.allowFallback === true, details: data }
        ));
        return;
      }
    };

    const onTranscript = async (payload) => {
      if (!payload || payload.type !== 'stt_transcript') return;
      this.emit('final', {
        utteranceId: this.activeUtteranceId || payload.transcriptId || 'utterance',
        language: this.config.language || 'tr-TR',
        transcript: payload.text || '',
        noSpeech: !payload.text,
        metadata: payload.metadata
      });
    };

    await sttStreamService.startStream(
      {
        session: sessionRow,
        user: userRow,
        sendEvent,
        onTranscript
      },
      {
        sampleRate: this.config.sampleRate || 16000,
        encoding: 'pcm16',
        language: this.config.language
      }
    );
    this.started = true;
  }

  async pushAudioChunk(payload) {
    if (!this.started || !this.session) {
      throw new VoiceStreamError('STT_NOT_READY', 'Realtime STT henüz başlamadı', { recoverable: true });
    }
    this.activeUtteranceId = payload.utteranceId || this.activeUtteranceId;
    if (!Buffer.isBuffer(payload.audioBytes) || payload.audioBytes.length === 0) {
      // Whisper REST'de textHint kabul ediyorduk; realtime'da göz ardı ediyoruz.
      return;
    }
    await sttStreamService.pushAudioChunk(
      { session: this.session, user: this.user, sendEvent: () => {} },
      { audio: payload.audioBytes }
    );
  }

  async finalizeUtterance(utteranceId) {
    // OpenAI Realtime API server-VAD'i otomatik buffer commit yapıyor.
    // Bizim ekstra `input_audio_buffer.commit` göndermemiz, server zaten
    // boşaltmış olduğu için "buffer too small. Expected at least 100ms"
    // hatasına düşürüyor.
    //
    // Bu yüzden realtime provider için finalizeUtterance no-op:
    // - Sadece activeUtteranceId'yi log için günceller.
    // - stopStream çağrısı YAPMAZ (commit tetiklenmez).
    //
    // Manuel commit istenirse client `vad: 'stop'` veya `isFinal: true`
    // ile bir audio chunk gönderebilir; appendChunk içinde pendingCommitMs
    // ≥ 100ms olduğunda commit tetikleniyor.
    this.activeUtteranceId = utteranceId || this.activeUtteranceId;
  }

  async close() {
    if (!this.session) return;
    try {
      await sttStreamService.terminateStream(this.session.id);
    } catch (_) {}
    this.started = false;
  }
}

module.exports = OpenAiRealtimeSttProvider;
