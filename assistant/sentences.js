// Splits streaming LLM text into sentences as they complete so TTS can start
// speaking before the model has finished. push() feeds deltas; flush() emits
// whatever is left at the end of the stream.

// Sentence-ending punctuation (optionally followed by closing quotes/brackets)
// or a newline, but only when followed by whitespace — never at the very end
// of the buffer, so "3." in "3.5 apples" isn't split mid-number.
const BOUNDARY = /[.!?…]+["'’)\]]*(?=\s)|\n+/;
const MIN_CHARS = 12; // avoid emitting tiny fragments like "Hi." on their own

export function createSentenceSplitter(onSentence) {
  let buffer = '';

  return {
    push(delta) {
      buffer += delta;
      let searchFrom = 0;
      for (;;) {
        const match = BOUNDARY.exec(buffer.slice(searchFrom));
        if (!match) break;
        const end = searchFrom + match.index + match[0].length;
        if (buffer.slice(0, end).trim().length < MIN_CHARS) {
          searchFrom = end; // too short — look for the next boundary instead
          continue;
        }
        const sentence = buffer.slice(0, end).trim();
        buffer = buffer.slice(end);
        searchFrom = 0;
        if (sentence) onSentence(sentence);
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) onSentence(rest);
    },
  };
}
