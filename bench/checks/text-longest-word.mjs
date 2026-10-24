import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/words.js`).href);
assert.equal(m.longestWord('aa bb c'), 'aa');
assert.equal(m.longestWord('a  bbb cc'), 'bbb');
assert.equal(m.longestWord('x'), 'x');
assert.equal(m.longestWord(''), '');
