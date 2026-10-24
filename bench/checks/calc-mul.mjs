import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/calc.js`).href);
assert.equal(m.mul(3, 4), 12);
assert.equal(m.mul(-2, 5), -10);
assert.equal(m.mul(0, 9), 0);
assert.equal(m.add(1, 2), 3);
