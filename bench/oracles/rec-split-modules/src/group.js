export function groupBy(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it);
    (out[k] ||= []).push(it);
  }
  return out;
}
