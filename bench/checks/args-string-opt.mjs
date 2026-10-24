import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/args.js`).href);
assert.deepEqual(m.parseArgs(['--out', 'a.txt', 'x'], { string: ['out'] }), { flags: { out: 'a.txt' }, positional: ['x'] });
assert.deepEqual(m.parseArgs(['-o', 'b', 'y'], { string: ['o'] }), { flags: { o: 'b' }, positional: ['y'] });
assert.deepEqual(m.parseArgs(['--out=c'], { string: ['out'] }).flags, { out: 'c' });
assert.throws(() => m.parseArgs(['--out'], { string: ['out'] }), Error);
assert.deepEqual(m.parseArgs(['--out', 'a']), { flags: { out: true }, positional: ['a'] });
