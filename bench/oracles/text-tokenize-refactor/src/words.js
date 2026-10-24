export function tokenize(s) {
  return s.split(/\s+/).filter(Boolean);
}

export function countWords(s) {
  return tokenize(s).length;
}

export function longestWord(s) {
  let best = '';
  for (const w of tokenize(s)) {
    if (w.length > best.length) best = w;
  }
  return best;
}
