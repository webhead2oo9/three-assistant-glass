// Word-wraps the caption for the Looking Glass caption plate and keeps only
// the lines that fit, newest last. The HTML caption card scrolls on its own;
// the 3D plate is a fixed-size canvas, so a long reply would otherwise run
// off the bottom and vanish.

export function wrapLines(text, measure, maxWidth) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    const words = paragraph.split(' ').filter(Boolean);
    if (words.length === 0) { lines.push(''); continue; }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) { current = candidate; continue; }
      if (current) lines.push(current);
      // A single word wider than the plate (a URL, say) is broken by character
      current = '';
      for (const char of word) {
        const next = current + char;
        if (current && measure(next) > maxWidth) { lines.push(current); current = char; }
        else current = next;
      }
    }
    lines.push(current);
  }
  return lines;
}

// Returns the last `maxLines` wrapped lines so the plate tail-scrolls
export function layoutCaption(text, { measure, maxWidth, maxLines }) {
  const lines = wrapLines(text, measure, maxWidth);
  const visible = Math.max(1, Math.floor(maxLines));
  return lines.length > visible ? lines.slice(-visible) : lines;
}
