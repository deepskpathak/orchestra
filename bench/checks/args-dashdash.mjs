import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/args.js`).href);
assert.deepEqual(m.parseArgs(['-v', '--', '--x', '-y', 'z']), { flags: { v: true }, positional: ['--x', '-y', 'z'] });
assert.deepEqual(m.parseArgs(['--', '--']), { flags: {}, positional: ['--'] });
assert.deepEqual(m.parseArgs(['--a=1', 'p']), { flags: { a: '1' }, positional: ['p'] });
