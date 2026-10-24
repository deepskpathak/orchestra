import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/records.js`).href);
const input = [{ n: 3 }, { n: 1 }, { n: 2 }];
const out = m.sortBy(input, 'n');
assert.deepEqual(out.map((x) => x.n), [1, 2, 3]);
assert.deepEqual(input.map((x) => x.n), [3, 1, 2]);
assert.notEqual(out, input);
