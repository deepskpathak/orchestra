import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/words.js`).href);
assert.equal(m.countWords(''), 0);
assert.equal(m.countWords('   '), 0);
assert.equal(m.countWords('  a   b '), 2);
assert.equal(m.countWords('one two three'), 3);
