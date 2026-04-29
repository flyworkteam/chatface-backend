const axios = require('axios');
const FormData = require('form-data');
const SttProvider = require('./SttProvider');
const { VoiceStreamError } = require('../errors');
const { retryWithBackoff } = require('../retry');
const { pcm16ToWavBuffer } = require('../audioUtils');

/**
 * OpenAI Whisper REST batch provider. Audio chunk'ları biriktirip
 * finalizeUtterance'da tek seferlik /audio/transcriptions çağrısı yapar.
 * Realtime değil — düşük latency gerektiren senaryolarda OpenAiRealtimeSttProvider
 * kullanılmalı.
 */
class OpenAiWhisperSttProvider extends SttProvider {
  constructor(config = {}) {
    super(config);
    this.utteranceStore = new Map();
  }

  async startSession() {
    return true;
  }

  _ensureUtterance(utteranceId, payload = {}) {
    const current = this.utteranceStore.get(utteranceId) || {
      chunks: [],
      hints: [],
      sampleRate: payload.audio?.sampleRate || this.config.sampleRate || 16000,
      channels: payload.audio?.channels || 1,
      language: payload.language || this.config.language || 'tr-TR'
    };
    this.utteranceStore.set(utteranceId, current);
    return current;
  }

  async pushAudioChunk(payload) {
    const { utteranceId, textHint, audioBytes } = payload;
    if (!utteranceId) {
      throw new VoiceStreamError('BAD_UTTERANCE_ID', 'utteranceId gerekli', { recoverable: false });
    }
    const state = this._ensureUtterance(utteranceId, payload);
    if (Buffer.isBuffer(audioBytes) && audioBytes.length > 0) {
      state.chunks.push(audioBytes);
    }
    if (typeof textHint === 'string' && textHint.trim()) {
      state.hints.push(textHint.trim());
      this.emit('partial', {
        utteranceId,
        language: state.language,
        transcript: state.hints.join(' ').slice(0, 250)
      });
    }
  }

  _mapAxiosError(error) {
    const status = error?.response?.status;
    if ([429, 500, 502, 503, 504].includes(status)) {
      return new VoiceStreamError(
        'STT_TEMPORARY_FAILURE',
        `STT provider temporary failure (${status})`,
        { recoverable: true, details: error?.response?.data || null }
      );
    }
    if (error?.code === 'ECONNABORTED') {
      return new VoiceStreamError('STT_TIMEOUT', 'STT timeout', { recoverable: true });
    }
    return new VoiceStreamError('STT_TRANSCRIBE_FAILED', 'STT transcribe failed', {
      recoverable: true,
      details: error?.response?.data || error?.message || null
    });
  }

  async _transcribeWithModel({ wav, apiKey, model, language, transcriptionPrompt, sttTemperature }) {
    const form = new FormData();
    form.append('file', wav, {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    form.append('model', model);
    if (language) form.append('language', language);
    form.append('prompt', transcriptionPrompt);
    form.append('temperature', String(sttTemperature));

    const response = await retryWithBackoff(async () => {
      return axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...form.getHeaders()
        },
        timeout: 20000,
        maxBodyLength: Infinity
      });
    }, { retries: 2, baseDelayMs: 250 });

    return String(response.data?.text || '').trim();
  }

  async _transcribeWithOpenAI(state) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new VoiceStreamError('OPENAI_API_KEY_MISSING', 'OPENAI_API_KEY tanımlı değil', { recoverable: false });
    }

    const model = process.env.OPENAI_STT_MODEL || 'whisper-1';
    const language = (state.language || 'tr-TR').toLowerCase().startsWith('tr') ? 'tr' : undefined;
    const pcm = Buffer.concat(state.chunks);
    const wav = pcm16ToWavBuffer(pcm, state.sampleRate || 16000, state.channels || 1);
    const transcriptionPrompt = process.env.OPENAI_STT_PROMPT || 'Türkçe konuşmayı doğru yaz. Belirsiz sesi uydurma.';
    const sttTemperatureRaw = Number(process.env.OPENAI_STT_TEMPERATURE);
    const sttTemperature = Number.isFinite(sttTemperatureRaw) ? sttTemperatureRaw : 0;

    try {
      return await this._transcribeWithModel({
        wav,
        apiKey,
        model,
        language,
        transcriptionPrompt,
        sttTemperature
      });
    } catch (error) {
      const mapped = this._mapAxiosError(error);
      if (mapped.code === 'STT_TRANSCRIBE_FAILED' && model !== 'whisper-1') {
        try {
          console.log(`[STT] primary model failed, fallback to whisper-1 | primary=${model}`);
          return await this._transcribeWithModel({
            wav,
            apiKey,
            model: 'whisper-1',
            language,
            transcriptionPrompt,
            sttTemperature
          });
        } catch (fallbackError) {
          throw this._mapAxiosError(fallbackError);
        }
      }
      throw mapped;
    }
  }

  async finalizeUtterance(utteranceId) {
    const state = this.utteranceStore.get(utteranceId) || {
      chunks: [],
      hints: [],
      language: this.config.language || 'tr-TR'
    };
    this.utteranceStore.delete(utteranceId);

    const minAudioBytes = Number(process.env.STT_MIN_AUDIO_BYTES || 3200);
    const totalAudioBytes = state.chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
    const hintsText = state.hints.join(' ').trim();

    console.log(
      `[STT] finalize.start | utteranceId=${utteranceId} chunks=${state.chunks.length} totalAudioBytes=${totalAudioBytes} minAudioBytes=${minAudioBytes} hintsLen=${hintsText.length}`
    );

    let transcript = '';
    if (state.chunks.length > 0 && totalAudioBytes >= minAudioBytes) {
      transcript = await this._transcribeWithOpenAI(state);
      if (!String(transcript || '').trim() && hintsText) {
        transcript = hintsText;
      }
    } else {
      transcript = hintsText;
    }
    const cleaned = String(transcript || '').trim();
    const minChars = Number(process.env.STT_MIN_TRANSCRIPT_CHARS || 2);
    const noSpeech = !cleaned || cleaned.length < minChars;

    console.log(
      `[STT] finalize.result | utteranceId=${utteranceId} transcriptLen=${cleaned.length} noSpeech=${noSpeech} language=${state.language || this.config.language || 'tr-TR'}`
    );

    this.emit('final', {
      utteranceId,
      language: state.language || this.config.language || 'tr-TR',
      transcript: noSpeech ? '' : cleaned,
      noSpeech
    });
  }
}

module.exports = OpenAiWhisperSttProvider;
