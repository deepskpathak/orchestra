export function add(a, b) {
  return a + b;
}

export function divide(a, b) {
  return a / b;
}

export function mean(xs) {
  if (xs.length === 0) throw new RangeError('mean of an empty array');
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
