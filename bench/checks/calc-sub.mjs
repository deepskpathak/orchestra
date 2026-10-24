import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { sub, add } = await import(pathToFileURL(`${process.cwd()}/src/calc.js`).href);
assert.equal(sub(5, 3), 2);
assert.equal(sub(0, 4), -4);
assert.equal(add(1, 1), 2);
