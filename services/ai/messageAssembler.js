const SENTENCE_BOUNDARY_REGEX = /(?<=[\.\!\?])/;
const MIN_SPEECH_CHUNK_CHARS = parseInt(process.env.TTS_MIN_CHUNK_CHARS || '48', 10);
const MIN_SPEECH_CHUNK_WORDS = parseInt(process.env.TTS_MIN_CHUNK_WORDS || '6', 10);
const MAX_SPEECH_CHUNK_CHARS = parseInt(process.env.TTS_MAX_CHUNK_CHARS || '180', 10);

const getWordCount = (text = '') => {
  return text.trim().split(/\s+/).filter(Boolean).length;
};

const mergeChunks = (left = '', right = '') => {
  return `${left} ${right}`.replace(/\s+/g, ' ').trim();
};

const shouldHoldChunk = (text = '') => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.length < MIN_SPEECH_CHUNK_CHARS || getWordCount(trimmed) < MIN_SPEECH_CHUNK_WORDS;
};

const shouldEmitChunk = (text = '') => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length >= MAX_SPEECH_CHUNK_CHARS) {
    return true;
  }
  return !shouldHoldChunk(trimmed);
};

const appendSpeechSentence = (pendingChunk = '', sentence = '') => {
  const trimmedSentence = sentence.trim();
  if (!trimmedSentence) {
    return { pendingChunk, emittedChunks: [] };
  }

  if (!pendingChunk) {
    return shouldEmitChunk(trimmedSentence)
      ? { pendingChunk: '', emittedChunks: [trimmedSentence] }
      : { pendingChunk: trimmedSentence, emittedChunks: [] };
  }

  const merged = mergeChunks(pendingChunk, trimmedSentence);
  if (merged.length > MAX_SPEECH_CHUNK_CHARS) {
    return shouldEmitChunk(trimmedSentence)
      ? { pendingChunk: '', emittedChunks: [pendingChunk, trimmedSentence] }
      : { pendingChunk: trimmedSentence, emittedChunks: [pendingChunk] };
  }

  if (/[\?\!]$/.test(trimmedSentence) || shouldEmitChunk(merged)) {
    return { pendingChunk: '', emittedChunks: [merged] };
  }

  return { pendingChunk: merged, emittedChunks: [] };
};

const splitIntoSentences = (text = '') => {
  return text
    .split(SENTENCE_BOUNDARY_REGEX)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
};

const splitIntoSpeechChunks = (text = '') => {
  const chunks = [];
  let pendingChunk = '';

  splitIntoSentences(text).forEach((sentence) => {
    const result = appendSpeechSentence(pendingChunk, sentence);
    pendingChunk = result.pendingChunk;
    chunks.push(...result.emittedChunks);
  });

  if (pendingChunk) {
    chunks.push(pendingChunk);
  }

  return chunks;
};

class SentenceAssembler {
  constructor({ onSentenceComplete }) {
    this.buffer = '';
    this.pendingChunk = '';
    this.onSentenceComplete = onSentenceComplete;
  }

  append(delta) {
    this.buffer += delta;
    const parts = this.buffer.split(SENTENCE_BOUNDARY_REGEX);
    this.buffer = parts.pop() || '';

    parts.forEach((sentence) => {
      const result = appendSpeechSentence(this.pendingChunk, sentence);
      this.pendingChunk = result.pendingChunk;
      result.emittedChunks.forEach((chunk) => {
        if (chunk) {
          this.onSentenceComplete(chunk);
        }
      });
    });
  }

  flush() {
    const remainder = this.buffer.trim();
    if (remainder) {
      const result = appendSpeechSentence(this.pendingChunk, remainder);
      this.pendingChunk = result.pendingChunk;
      result.emittedChunks.forEach((chunk) => {
        if (chunk) {
          this.onSentenceComplete(chunk);
        }
      });
      this.buffer = '';
    }

    if (this.pendingChunk) {
      const chunk = this.pendingChunk.trim();
      if (chunk) {
        this.onSentenceComplete(chunk);
      }
      this.pendingChunk = '';
    }
    this.buffer = '';
  }
}

module.exports = SentenceAssembler;
module.exports.splitIntoSentences = splitIntoSentences;
module.exports.splitIntoSpeechChunks = splitIntoSpeechChunks;
