import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/text.js`).href);
assert.equal(m.truncate('hello', 10), 'hello');
assert.equal(m.truncate('hello world', 8), 'hello...');
assert.equal(m.truncate('abc', 3), 'abc');
assert.equal(m.truncate('abcd', 3), '...');
assert.equal(m.capitalize('x'), 'X');
