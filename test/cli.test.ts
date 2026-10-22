import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_ROOT, packageVersion } from '../src/harness.ts';
import { main } from '../src/cli.ts';

test('packageVersion matches package.json and plugin manifest', () => {
  const plugin = JSON.parse(readFileSync(join(PACKAGE_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(plugin.version, packageVersion());
});

test('--version and -v print the version', async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => void lines.push(m);
  try {
    await main(['--version']);
    await main(['-v']);
  } finally {
    console.log = orig;
  }
  assert.deepEqual(lines, [packageVersion(), packageVersion()]);
});
