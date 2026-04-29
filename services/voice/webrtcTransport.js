const { VoiceStreamError } = require('./errors');

let wrtc = null;
try {
  // WebRTC çağrı akışı için zorunlu dependency.
  // Native build problemli olduğu için production image'da
  // `apt-get install build-essential libopus-dev cmake python3`
  // + `npm rebuild wrtc` adımı eklenmeli.
  // Modül yüklenemezse hasWebRtcRuntime() false döner ve gateway
  // WEBRTC_RUNTIME_MISSING hatasıyla çağrıyı reddeder.
  // eslint-disable-next-line global-require
  wrtc = require('wrtc');
} catch (_) {
  wrtc = null;
}

function hasWebRtcRuntime() {
  return Boolean(wrtc && wrtc.RTCPeerConnection);
}

function parseIceServers() {
  const raw = process.env.WEBRTC_ICE_SERVERS || '';
  if (!raw.trim()) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch (_) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

class WebRtcTransport {
  constructor({ onPcmFrame, onTrack }) {
    if (!hasWebRtcRuntime()) {
      throw new VoiceStreamError(
        'WEBRTC_RUNTIME_MISSING',
        'wrtc modülü kurulu değil. WebRTC için `npm i wrtc` gerekir.',
        { recoverable: false }
      );
    }
    this.onPcmFrame = onPcmFrame;
    this.onTrack = onTrack;
    this.pc = null;
    this.audioSink = null;
    this.candidatesBuffer = [];
    this.remoteDescriptionSet = false;
  }

  async init() {
    const { RTCPeerConnection } = wrtc;
    this.pc = new RTCPeerConnection({
      iceServers: parseIceServers()
    });

    this.pc.ontrack = (event) => {
      const track = event.track;
      if (!track) return;
      this.onTrack?.({
        kind: track.kind,
        id: track.id,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState
      });
      if (track.kind !== 'audio') return;
      if (!wrtc.nonstandard || !wrtc.nonstandard.RTCAudioSink) return;
      if (!this.onPcmFrame) return;

      this.audioSink = new wrtc.nonstandard.RTCAudioSink(track);
      this.audioSink.ondata = (frame) => {
        // frame.samples: Int16Array (PCM16)
        const samples = frame.samples;
        if (!samples) return;
        const audioBytes = Buffer.from(samples.buffer);
        this.onPcmFrame?.({
          audioBytes,
          sampleRate: frame.sampleRate || 48000,
          channels: frame.channelCount || 1,
          bitsPerSample: frame.bitsPerSample || 16,
          numberOfFrames: frame.numberOfFrames || 0
        });
      };
    };
  }

  async createAnswerFromOffer(sdpOffer) {
    if (!this.pc) await this.init();
    const { RTCSessionDescription } = wrtc;
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdpOffer }));
    this.remoteDescriptionSet = true;

    for (const c of this.candidatesBuffer) {
      // eslint-disable-next-line no-await-in-loop
      await this.pc.addIceCandidate(c);
    }
    this.candidatesBuffer = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription?.sdp;
  }

  async addIceCandidate(candidate) {
    if (!this.pc) await this.init();
    if (!candidate) return;
    if (!this.remoteDescriptionSet) {
      this.candidatesBuffer.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  close() {
    try {
      if (this.audioSink) this.audioSink.stop();
    } catch (_) {}
    this.audioSink = null;
    try {
      if (this.pc) this.pc.close();
    } catch (_) {}
    this.pc = null;
  }
}

module.exports = {
  WebRtcTransport,
  hasWebRtcRuntime
};
