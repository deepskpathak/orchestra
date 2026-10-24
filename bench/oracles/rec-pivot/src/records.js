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

export function pivot(rows, rowKey, colKey, valueKey) {
  const out = {};
  for (const row of rows) {
    (out[row[rowKey]] ||= {})[row[colKey]] = row[valueKey];
  }
  return out;
}
