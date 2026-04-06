const splitIntoSentences = (text = '') => {
  return text
    .split(/(?<=[\\.\\!\\?])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
};

class SentenceAssembler {
  constructor({ onSentenceComplete }) {
    this.buffer = '';
    this.onSentenceComplete = onSentenceComplete;
  }

  append(delta) {
    this.buffer += delta;
    const parts = this.buffer.split(/(?<=[\\.\\!\\?])/);
    this.buffer = parts.pop() || '';

    parts.forEach((sentence) => {
      const trimmed = sentence.trim();
      if (trimmed) {
        this.onSentenceComplete(trimmed);
      }
    });
  }

  flush() {
    const trimmed = this.buffer.trim();
    if (trimmed) {
      this.onSentenceComplete(trimmed);
    }
    this.buffer = '';
  }
}

module.exports = SentenceAssembler;
module.exports.splitIntoSentences = splitIntoSentences;
