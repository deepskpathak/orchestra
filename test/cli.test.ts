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

test('learnings --domain filters by domain, supports global, and rejects unknown domains', async () => {
  const { spawnSync, execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Store } = await import('../src/store.ts');
  const { writeLearnings } = await import('../src/learnings.ts');
  const dir = mkdtempSync(join(tmpdir(), 'orch-learn-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.orchestra'));
  writeFileSync(join(dir, '.orchestra', 'config.json'), '{}');
  const store = new Store(dir);
  writeLearnings(store, [{ role: 'worker', lesson: 'CLILESSON', evidence: [{ run: 'r1', task: 'T2' }], hits: 3 }], 'r1', 'cli');
  writeLearnings(store, [{ role: 'planner', lesson: 'GLOBALLESSON', evidence: [{ run: 'r1' }], hits: 0 }], 'r1');
  writeLearnings(store, [{ role: 'worker', lesson: 'DOCSLESSON', evidence: [{ run: 'r1' }], hits: 0 }], 'r1', 'docs');
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'learnings', ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });

  const c = run('--domain', 'cli');
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /CLILESSON/);
  assert.match(c.stdout, /r1\/T2/);
  assert.match(c.stdout, /hits: 3/);
  assert.doesNotMatch(c.stdout, /GLOBALLESSON|DOCSLESSON/);

  const g = run('--domain', 'global');
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /GLOBALLESSON/);
  assert.doesNotMatch(g.stdout, /CLILESSON|DOCSLESSON/);

  const u = run('--domain', 'nope');
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /Unknown domain "nope"/);
  assert.match(u.stderr, /global, cli, docs/);

  const all = run();
  assert.match(all.stdout, /CLILESSON/);
  assert.match(all.stdout, /GLOBALLESSON/);
});
