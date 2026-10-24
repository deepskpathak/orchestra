import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/calc.js`).href);
assert.equal(m.pow(2, 10), 1024);
assert.equal(m.pow(5, 0), 1);
assert.equal(m.pow(3, 1), 3);
assert.throws(() => m.pow(2, -1), RangeError);
assert.throws(() => m.pow(2, 1.5), RangeError);
