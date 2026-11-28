// Strict CSV reader: rows are parsed with the 1-based line each one starts on, so errors can name it.
export function parseCsv(text, opts = {}) {
  const d = opts.delimiter ?? ',';
  let s = String(text);
  if (s.startsWith('﻿')) s = s.slice(1);
  const rows = [];
  let i = 0;
  let line = 1;
  while (i < s.length) {
    // Skip completely empty lines between rows.
    if (s[i] === '\n') { i++; line++; continue; }
    if (s[i] === '\r' && s[i + 1] === '\n') { i += 2; line++; continue; }
    const start = line;
    const fields = [];
    for (;;) {
      let f = '';
      if (s[i] === '"') {
        i++;
        for (;;) {
          if (i >= s.length) throw new Error(`unterminated quoted field on line ${start}`);
          const c = s[i];
          if (c === '"') {
            if (s[i + 1] === '"') { f += '"'; i += 2; continue; }
            i++;
            break;
          }
          if (c === '\n') line++;
          f += c;
          i++;
        }
        const next = s[i];
        if (!(next === undefined || next === d || next === '\n' || (next === '\r' && s[i + 1] === '\n'))) throw new Error(`unexpected character after closing quote on line ${start}`);
      } else {
        while (i < s.length && s[i] !== d && s[i] !== '\n' && !(s[i] === '\r' && s[i + 1] === '\n')) {
          if (s[i] === '"') throw new Error(`quote inside an unquoted field on line ${start}`);
          f += s[i++];
        }
      }
      fields.push(f);
      if (s[i] === d) { i++; continue; }
      if (s[i] === '\r') i++;
      if (s[i] === '\n') { i++; line++; }
      break;
    }
    rows.push({ fields, line: start });
  }
  if (!rows.length) return [];
  const [head, ...body] = rows;
  const names = head.fields;
  if (new Set(names).size !== names.length) throw new Error(`duplicated header name on line ${head.line}`);
  return body.map((r) => {
    if (r.fields.length !== names.length) throw new Error(`expected ${names.length} fields, got ${r.fields.length} on line ${r.line}`);
    return Object.fromEntries(names.map((n, k) => [n, r.fields[k]]));
  });
}
