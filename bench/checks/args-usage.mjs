import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/usage.js`).href);
const out = m.formatUsage({ name: 'tool', description: 'Does things.', options: [{ flag: 'out', desc: 'Output file', default: 'a.txt' }, { flag: 'v', desc: 'Verbose' }] });
assert.equal(out, ['Usage: tool [options]', 'Does things.', '', 'Options:', '  --out  Output file (default: a.txt)', '  --v    Verbose'].join('\n'));
assert.equal(m.formatUsage({ name: 'x' }), ['Usage: x [options]', '', 'Options:'].join('\n'));
assert.equal(m.formatUsage({ name: 'x', options: [{ flag: 'n', desc: 'Count', default: 0 }] }), ['Usage: x [options]', '', 'Options:', '  --n  Count (default: 0)'].join('\n'));
