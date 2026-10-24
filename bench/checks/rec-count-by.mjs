import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/records.js`).href);
assert.deepEqual(m.countBy(['a', 'bb', 'cc', 'd', 'eee'], (s) => s.length), { 1: 2, 2: 2, 3: 1 });
assert.deepEqual(m.countBy([], (x) => x), {});
assert.deepEqual(m.groupBy([1, 2, 3], (n) => n % 2), { 1: [1, 3], 0: [2] });
