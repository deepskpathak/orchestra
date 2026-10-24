export function add(a, b) {
  return a + b;
}

export function divide(a, b) {
  return a / b;
}

export function pow(base, exp) {
  if (!Number.isInteger(exp) || exp < 0) throw new RangeError('exp must be a non-negative integer');
  let out = 1;
  for (let i = 0; i < exp; i++) out *= base;
  return out;
}
