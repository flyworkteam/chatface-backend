const SENTENCE_BOUNDARY_REGEX = /(?<=[\.\!\?])/;
const MIN_SPEECH_CHUNK_CHARS = parseInt(process.env.TTS_MIN_CHUNK_CHARS || '48', 10);
const MIN_SPEECH_CHUNK_WORDS = parseInt(process.env.TTS_MIN_CHUNK_WORDS || '6', 10);
const MAX_SPEECH_CHUNK_CHARS = parseInt(process.env.TTS_MAX_CHUNK_CHARS || '180', 10);
const FIRST_CHUNK_MIN_CHARS = parseInt(process.env.TTS_FIRST_CHUNK_MIN_CHARS || '28', 10);
const FIRST_CHUNK_MIN_WORDS = parseInt(process.env.TTS_FIRST_CHUNK_MIN_WORDS || '4', 10);
const FIRST_CLAUSE_BOUNDARY_REGEX = /[,;:]\s+/g;

const getWordCount = (text = '') => {
  return text.trim().split(/\s+/).filter(Boolean).length;
};

const mergeChunks = (left = '', right = '') => {
  return `${left} ${right}`.replace(/\s+/g, ' ').trim();
};

const shouldHoldChunk = (text = '', options = {}) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const minChars = options.isFirstChunk ? FIRST_CHUNK_MIN_CHARS : MIN_SPEECH_CHUNK_CHARS;
  const minWords = options.isFirstChunk ? FIRST_CHUNK_MIN_WORDS : MIN_SPEECH_CHUNK_WORDS;
  return trimmed.length < minChars || getWordCount(trimmed) < minWords;
};

const shouldEmitChunk = (text = '', options = {}) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length >= MAX_SPEECH_CHUNK_CHARS) {
    return true;
  }
  return !shouldHoldChunk(trimmed, options);
};

const appendSpeechSentence = (pendingChunk = '', sentence = '', options = {}) => {
  const trimmedSentence = sentence.trim();
  if (!trimmedSentence) {
    return { pendingChunk, emittedChunks: [] };
  }

  if (!pendingChunk) {
    return shouldEmitChunk(trimmedSentence, options)
      ? { pendingChunk: '', emittedChunks: [trimmedSentence] }
      : { pendingChunk: trimmedSentence, emittedChunks: [] };
  }

  const merged = mergeChunks(pendingChunk, trimmedSentence);
  if (merged.length > MAX_SPEECH_CHUNK_CHARS) {
    return shouldEmitChunk(trimmedSentence, options)
      ? { pendingChunk: '', emittedChunks: [pendingChunk, trimmedSentence] }
      : { pendingChunk: trimmedSentence, emittedChunks: [pendingChunk] };
  }

  if (/[\?\!]$/.test(trimmedSentence) || shouldEmitChunk(merged, options)) {
    return { pendingChunk: '', emittedChunks: [merged] };
  }

  return { pendingChunk: merged, emittedChunks: [] };
};

const extractFirstClause = (text = '') => {
  FIRST_CLAUSE_BOUNDARY_REGEX.lastIndex = 0;
  let match;
  let boundaryIndex = -1;
  while ((match = FIRST_CLAUSE_BOUNDARY_REGEX.exec(text)) !== null) {
    boundaryIndex = match.index + match[0].length;
    const candidate = text.slice(0, boundaryIndex).trim();
    if (shouldEmitChunk(candidate, { isFirstChunk: true })) {
      return {
        clause: candidate,
        remainder: text.slice(boundaryIndex)
      };
    }
  }
  return null;
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
    this.hasEmittedChunk = false;
  }

  append(delta) {
    this.buffer += delta;
    if (!this.hasEmittedChunk && !this.pendingChunk) {
      const firstClause = extractFirstClause(this.buffer);
      if (firstClause) {
        this.buffer = firstClause.remainder;
        this.hasEmittedChunk = true;
        this.onSentenceComplete(firstClause.clause);
      }
    }
    const parts = this.buffer.split(SENTENCE_BOUNDARY_REGEX);
    this.buffer = parts.pop() || '';

    parts.forEach((sentence) => {
      const result = appendSpeechSentence(this.pendingChunk, sentence, {
        isFirstChunk: !this.hasEmittedChunk
      });
      this.pendingChunk = result.pendingChunk;
      result.emittedChunks.forEach((chunk) => {
        if (chunk) {
          this.hasEmittedChunk = true;
          this.onSentenceComplete(chunk);
        }
      });
    });
  }

  flush() {
    const remainder = this.buffer.trim();
    if (remainder) {
      const result = appendSpeechSentence(this.pendingChunk, remainder, {
        isFirstChunk: !this.hasEmittedChunk
      });
      this.pendingChunk = result.pendingChunk;
      result.emittedChunks.forEach((chunk) => {
        if (chunk) {
          this.hasEmittedChunk = true;
          this.onSentenceComplete(chunk);
        }
      });
      this.buffer = '';
    }

    if (this.pendingChunk) {
      const chunk = this.pendingChunk.trim();
      if (chunk) {
        this.hasEmittedChunk = true;
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
