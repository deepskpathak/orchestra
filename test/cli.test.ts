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

test('bench flags reject a missing value or a flag-like value, and non-numeric --seed/--repeats', async () => {
  const { spawnSync } = await import('node:child_process');
  const { tempRepo } = await import('./helpers.ts');
  const cwd = tempRepo().root;
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const cases: [string[], RegExp][] = [
    [['bench', '--arms', '--repeats', '3'], /--arms needs a value/],
    [['bench', '--repeats'], /--repeats needs a value/],
    [['bench', 'calibrate', '--seed', 'abc'], /--seed must be an integer/],
    [['bench', '--repeats', 'two'], /--repeats must be an integer/],
  ];
  for (const [args, msg] of cases) {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, msg, args.join(' '));
  }
});

test('atlas build and stats work on a real repo, hide .env, and reject unknown subcommands', async () => {
  const { spawnSync, execFileSync } = await import('node:child_process');
  const { existsSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'orch-atlas-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(dir, 'a.ts'), 'export function alphaFn() { return 1; }\n');
  writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=abc123\n');
  g('add', '-f', '-A');
  g('commit', '-qm', 'init');
  const sha = g('rev-parse', 'HEAD').trim();
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'atlas', ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });

  const b = run('build');
  assert.equal(b.status, 0, b.stderr);
  assert.ok(existsSync(join(dir, '.orchestra', 'atlas', `${sha}.json`)));
  assert.match(b.stdout, /1 files, [1-9]\d* symbols/);

  const s = run('stats');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /files\s+1\b/);
  assert.match(s.stdout, /symbols\s+[1-9]/);
  assert.doesNotMatch(s.stdout + b.stdout, /\.env|SECRET_TOKEN/);

  for (const args of [['bogus'], []]) {
    const r = run(...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Usage: orchestra atlas build/);
  }
});

test('evals ablation prints the with vs without lessons delta on the holdout, and says so when there is none', async () => {
  const { spawnSync, execFileSync } = await import('node:child_process');
  const { tempRepo } = await import('./helpers.ts');
  const store = tempRepo();
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const env = { ...process.env, ORCHESTRA_RUNNER: 'fake', ORCHESTRA_FAKE_STEP_MS: '0' };
  const run = () => spawnSync(process.execPath, [cli, 'evals', 'ablation'], { cwd: store.root, encoding: 'utf8', timeout: 120000, env });
  const none = run();
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /No holdout cases/);

  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: store.root, encoding: 'utf8' }).trim();
  for (let i = 0; i < 4; i++) store.writeJson(`evals/e${i}.json`, { id: `e${i}`, goal: `add feature number ${i}`, base, check: null, createdAt: 1000 + i });
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Lesson ablation on 1 holdout case/);
  assert.match(r.stdout, /e3  with [\d.]+  without [\d.]+  delta/);
  assert.match(r.stdout, /mean delta .* 95% CI \[/);
});
