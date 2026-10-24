import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/args.js';

test('long flag', () => assert.deepEqual(parseArgs(['--force']).flags, { force: true }));
test('long flag with value', () => assert.deepEqual(parseArgs(['--out=a.txt']).flags, { out: 'a.txt' }));
test('short flag', () => assert.deepEqual(parseArgs(['-v']).flags, { v: true }));
test('positionals keep order', () => assert.deepEqual(parseArgs(['a', '-v', 'b']).positional, ['a', 'b']));
test('empty input', () => assert.deepEqual(parseArgs([]), { flags: {}, positional: [] }));
