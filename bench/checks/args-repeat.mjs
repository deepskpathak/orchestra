import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/args.js`).href);
assert.deepEqual(m.parseArgs(['--tag=a', '--tag=b']).flags, { tag: ['a', 'b'] });
assert.deepEqual(m.parseArgs(['--tag=a']).flags, { tag: 'a' });
assert.deepEqual(m.parseArgs(['-v', '-v', '-v']).flags, { v: [true, true, true] });
assert.deepEqual(m.parseArgs(['--a=1', '--b=2']).flags, { a: '1', b: '2' });
