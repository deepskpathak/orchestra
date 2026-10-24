export function countWords(s) {
  return s.split(/\s+/).length;
}

export function longestWord(s) {
  let best = '';
  for (const w of s.split(' ')) {
    if (w.length > best.length) best = w;
  }
  return best;
}
