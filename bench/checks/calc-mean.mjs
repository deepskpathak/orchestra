import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/calc.js`).href);
assert.equal(m.mean([1, 2, 3]), 2);
assert.equal(m.mean([5]), 5);
assert.equal(m.mean([1, 2]), 1.5);
assert.throws(() => m.mean([]), RangeError);
