const WebSocket = require('ws');
const SttProvider = require('./SttProvider');
const { VoiceStreamError } = require('../errors');
const { retryWithBackoff } = require('../retry');

/**
 * Deepgram realtime STT (WebSocket). Sadece DEEPGRAM_API_KEY tanımlıysa çalışır.
 */
class DeepgramSttProvider extends SttProvider {
  constructor(config = {}) {
    super(config);
    this.ws = null;
    this.ready = false;
  }

  async startSession() {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new VoiceStreamError('DEEPGRAM_API_KEY_MISSING', 'DEEPGRAM_API_KEY tanımlı değil', { recoverable: false });
    }

    const language = (this.config.language || 'tr-TR').toLowerCase();
    const dgLang = language.startsWith('tr') ? 'tr' : 'en';
    const sampleRate = this.config.sampleRate || 16000;

    const url = new URL('wss://api.deepgram.com/v1/listen');
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(sampleRate));
    url.searchParams.set('channels', '1');
    url.searchParams.set('language', dgLang);
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('endpointing', '300');
    url.searchParams.set('vad_events', 'true');

    await retryWithBackoff(async () => {
      this.ws = new WebSocket(url.toString(), {
        headers: {
          Authorization: `Token ${apiKey}`
        }
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('deepgram_connect_timeout')), 6000);
        this.ws.once('open', () => {
          clearTimeout(timer);
          this.ready = true;
          resolve();
        });
        this.ws.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const isFinal = msg.is_final === true;
          const alt = msg.channel?.alternatives?.[0];
          const transcript = alt?.transcript || '';
          if (!transcript) return;

          if (isFinal) {
            this.emit('final', {
              utteranceId: this.config.activeUtteranceId || 'utterance',
              language: this.config.language || 'tr-TR',
              transcript
            });
          } else {
            this.emit('partial', {
              utteranceId: this.config.activeUtteranceId || 'utterance',
              language: this.config.language || 'tr-TR',
              transcript
            });
          }
        } catch (_) {
          // ignore non-json
        }
      });

      this.ws.on('close', () => {
        this.ready = false;
      });
    }, { retries: 2, baseDelayMs: 200 });
  }

  async pushAudioChunk(payload) {
    if (!this.ws || !this.ready) {
      throw new VoiceStreamError('STT_NOT_READY', 'STT websocket hazır değil', { recoverable: true });
    }
    this.config.activeUtteranceId = payload.utteranceId;
    const audioBytes = payload.audioBytes;
    if (!audioBytes || !Buffer.isBuffer(audioBytes)) {
      throw new VoiceStreamError('BAD_AUDIO_BYTES', 'audioBytes buffer olmalı', { recoverable: false });
    }
    this.ws.send(audioBytes);
  }

  async finalizeUtterance() {
    if (this.ws && this.ready) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch (_) {}
    }
  }

  async close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
    this.ws = null;
    this.ready = false;
  }
}

module.exports = DeepgramSttProvider;
