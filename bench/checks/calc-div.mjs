import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { divide } = await import(pathToFileURL(`${process.cwd()}/src/calc.js`).href);
assert.equal(divide(6, 3), 2);
assert.throws(() => divide(1, 0), RangeError);
