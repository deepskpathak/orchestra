import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/records.js`).href);
assert.deepEqual(m.chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
assert.deepEqual(m.chunk([], 3), []);
assert.deepEqual(m.chunk([1, 2, 3], 2), [[1, 2], [3]]);
assert.deepEqual(m.chunk([1], 5), [[1]]);
