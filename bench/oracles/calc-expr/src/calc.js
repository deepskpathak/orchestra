export function add(a, b) {
  return a + b;
}

export function divide(a, b) {
  return a / b;
}

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      i += m[0].length;
      if (s[i] === '.') throw new Error(`bad number at ${i}`);
      out.push({ t: 'num', v: Number(m[0]) });
      continue;
    }
    if ('+-*/^()'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`unexpected character ${c}`);
  }
  return out;
}

export function evaluate(expr) {
  const toks = tokenize(String(expr));
  if (!toks.length) throw new Error('empty expression');
  let p = 0;
  const peek = () => toks[p]?.t;
  const sum = () => {
    let v = product();
    while (peek() === '+' || peek() === '-') v = toks[p++].t === '+' ? v + product() : v - product();
    return v;
  };
  const product = () => {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      if (toks[p++].t === '*') v *= unary();
      else {
        const d = unary();
        if (d === 0) throw new Error('division by zero');
        v /= d;
      }
    }
    return v;
  };
  const unary = () => (peek() === '-' ? (p++, -unary()) : power());
  const power = () => {
    const b = atom();
    if (peek() === '^') { p++; return b ** unary(); }
    return b;
  };
  const atom = () => {
    const t = toks[p++];
    if (!t) throw new Error('missing operand');
    if (t.t === 'num') return t.v;
    if (t.t === '(') {
      const v = sum();
      if (toks[p++]?.t !== ')') throw new Error('unbalanced parentheses');
      return v;
    }
    throw new Error(`unexpected ${t.t}`);
  };
  const v = sum();
  if (p !== toks.length) throw new Error(`unexpected ${toks[p].t}`);
  return v;
}
