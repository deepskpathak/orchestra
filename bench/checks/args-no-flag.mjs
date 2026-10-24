import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/args.js`).href);
assert.deepEqual(m.parseArgs(['--no-color']).flags, { color: false });
assert.deepEqual(m.parseArgs(['--color']).flags, { color: true });
assert.deepEqual(m.parseArgs(['--no-cache', '--x=1']).flags, { cache: false, x: '1' });
