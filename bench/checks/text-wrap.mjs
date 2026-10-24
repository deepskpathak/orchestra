import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/text.js`).href);
assert.deepEqual(m.wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
assert.deepEqual(m.wrap('aaaa bb', 3), ['aaaa', 'bb']);
assert.deepEqual(m.wrap('  a   b  ', 10), ['a b']);
assert.deepEqual(m.wrap('', 5), []);
assert.deepEqual(m.wrap('a b c d', 3), ['a b', 'c d']);
