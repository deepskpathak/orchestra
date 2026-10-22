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

test('serve --tui and tui exit 1 with a hint when not on a TTY, and never start the web server', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  for (const args of [['serve', '--tui'], ['tui']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: '', timeout: 15000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /orchestra status/);
    assert.doesNotMatch(r.stdout, /dashboard: http/);
  }
});
