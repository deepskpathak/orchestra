export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function wrapText(s, width) {
  if (!(width >= 1)) throw new RangeError('width must be at least 1');
  const out = [];
  for (const para of s.split(/\n[ \t\r\f\v]*\n\s*/)) {
    const words = [];
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cps = [...word];
      for (let i = 0; i < cps.length; i += width) words.push(cps.slice(i, i + width).join(''));
    }
    if (!words.length) continue;
    if (out.length) out.push('');
    let line = '';
    for (const word of words) {
      if (!line) line = word;
      else if ([...line].length + 1 + [...word].length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}
