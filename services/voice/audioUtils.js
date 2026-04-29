/**
 * PCM16 buffer'ını WAV (RIFF) formatına sarar. Whisper REST gibi
 * dosya bekleyen STT API'leri için gerekli.
 */
function pcm16ToWavBuffer(pcmBuffer, sampleRate = 16000, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  let offset = 0;
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(36 + dataSize, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;
  buffer.writeUInt16LE(1, offset); offset += 2; // PCM
  buffer.writeUInt16LE(channels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  pcmBuffer.copy(buffer, offset);
  return buffer;
}

/**
 * PCM16 mono buffer'ı lineer enterpolasyon ile yeniden örnekler.
 * WebRTC RTCAudioSink tipik olarak 48kHz verdiği için STT'ye 16kHz
 * normalize etmekte kullanılır.
 */
function resamplePcm16(pcmBuffer, fromRate, toRate) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 2) {
    return Buffer.alloc(0);
  }
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    return Buffer.from(pcmBuffer);
  }
  if (fromRate === toRate) {
    return Buffer.from(pcmBuffer);
  }

  const inputSamples = Math.floor(pcmBuffer.length / 2);
  if (inputSamples <= 1) {
    return Buffer.from(pcmBuffer);
  }

  const source = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, inputSamples);
  const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
  const output = Buffer.alloc(outputSamples * 2);

  for (let outIndex = 0; outIndex < outputSamples; outIndex += 1) {
    const position = (outIndex * fromRate) / toRate;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, inputSamples - 1);
    const frac = position - leftIndex;

    const left = source[leftIndex];
    const right = source[rightIndex];
    const interpolated = left + ((right - left) * frac);

    let clamped = Math.round(interpolated);
    if (clamped > 32767) clamped = 32767;
    if (clamped < -32768) clamped = -32768;
    output.writeInt16LE(clamped, outIndex * 2);
  }

  return output;
}

module.exports = {
  pcm16ToWavBuffer,
  resamplePcm16
};
