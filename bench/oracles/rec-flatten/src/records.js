export function groupBy(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it);
    (out[k] ||= []).push(it);
  }
  return out;
}

export function sortBy(items, key) {
  return items.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i <= items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function flatten(items, depth = 1) {
  if (depth < 1) return items.slice();
  return items.reduce((acc, x) => (Array.isArray(x) ? acc.concat(flatten(x, depth - 1)) : acc.concat([x])), []);
}
