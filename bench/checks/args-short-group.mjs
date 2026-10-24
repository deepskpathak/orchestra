import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/args.js`).href);
assert.deepEqual(m.parseArgs(['-abc']).flags, { a: true, b: true, c: true });
assert.deepEqual(m.parseArgs(['-v', 'x']), { flags: { v: true }, positional: ['x'] });
assert.deepEqual(m.parseArgs(['-']), { flags: {}, positional: ['-'] });
