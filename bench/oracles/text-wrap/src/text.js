export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function wrap(s, width) {
  const lines = [];
  let cur = '';
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (cur === '') cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}
