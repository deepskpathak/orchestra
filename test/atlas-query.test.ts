import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildAtlas } from '../src/atlas.ts';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { DEFAULT_PROJECT_CONFIG, Store } from '../src/store.ts';
import { ATLAS_QUERY_HINT, DEFAULT_QUERY_CAP, STALE_MARK, find, impact, neighbors, parsePorcelain, runQuery, tests } from '../src/atlas-query.ts';
import { judgePrompt, workerPrompt } from '../src/conductor.ts';
import type { Atlas } from '../src/atlas.ts';
import { tempRepo } from './helpers.ts';

const fixture = (): Atlas => ({
  version: 2,
  sha: 'abc',
  skipped: [],
  files: {
    'src/a.ts': { lang: 'typescript', size: 1, lines: 1, imports: [], symbols: [{ name: 'alpha', kind: 'function', line: 3, exported: true }] },
    'src/b.ts': { lang: 'typescript', size: 1, lines: 1, imports: [], symbols: [] },
    'src/c.ts': { lang: 'typescript', size: 1, lines: 1, imports: [], symbols: [] },
    'test/a.test.ts': { lang: 'typescript', size: 1, lines: 1, imports: [], symbols: [] },
  },
  nodes: [
    { id: 'src/a.ts', kind: 'file', path: 'src/a.ts', name: 'a.ts' },
    { id: 'src/a.ts#alpha', kind: 'symbol', path: 'src/a.ts', name: 'alpha', symKind: 'function', line: 3, exported: true },
  ],
  edges: [
    { from: 'src/b.ts', to: 'src/a.ts', kind: 'imports' },
    { from: 'src/c.ts', to: 'src/a.ts#alpha', kind: 'references' },
    { from: 'test/a.test.ts', to: 'src/a.ts', kind: 'imports' },
    { from: 'test/a.test.ts', to: 'src/a.ts', kind: 'tests' },
    { from: 'src/a.ts', to: 'src/c.ts', kind: 'imports' },
  ],
});

test('find resolves paths and symbols as a tree, and reports misses', () => {
  const a = fixture();
  const sym = find(a, 'alpha');
  assert.ok(sym.found);
  assert.match(sym.text, /└── src\/a\.ts\n    └── alpha \(function, line 3, exported\)/);
  assert.match(find(a, 'a.ts').text, /src\/a\.ts/);
  assert.equal(find(a, 'nope').found, false);
});

test('neighbors lists imports and importers', () => {
  const t = neighbors(fixture(), 'src/a.ts').text;
  assert.match(t, /imports \(1\)\n.*src\/c\.ts/);
  assert.match(t, /imported by \(3\)/);
  assert.match(t, /src\/b\.ts \[imports\]/);
  assert.match(t, /src\/c\.ts \[references alpha\]/);
});

test('impact lists callers and tests, and adds an advisory note for a modified file with untouched callers', () => {
  const plain = impact(fixture(), 'alpha').text;
  assert.match(plain, /callers\/importers \(3\)/);
  assert.match(plain, /tests \(1\)/);
  assert.doesNotMatch(plain, /advisory/);
  const r = impact(fixture(), 'src/a.ts', { stale: ['src/a.ts', 'src/b.ts'] }).text;
  assert.match(r, /advisory: src\/a\.ts is modified but callers not updated: src\/c\.ts, test\/a\.test\.ts/);
  assert.ok(r.includes(`src/b.ts [imports] ${STALE_MARK}`));
});

test('tests lists only test files', () => {
  const t = tests(fixture(), 'src/a.ts').text;
  assert.match(t, /test\/a\.test\.ts/);
  assert.doesNotMatch(t, /src\/b\.ts/);
  assert.match(tests(fixture(), 'src/b.ts').text, /no test files found/);
});

test('cap truncates with a marker, default cap is 80', () => {
  const a = fixture();
  for (let i = 0; i < 100; i++) a.edges.push({ from: `src/x${i}.ts`, to: 'src/a.ts', kind: 'imports' });
  const t = neighbors(a, 'src/a.ts').text.split('\n');
  assert.equal(t.length, DEFAULT_QUERY_CAP);
  assert.match(t[t.length - 1]!, /^\.\.\. truncated, \d+ more lines \(cap 80\)$/);
  assert.equal(neighbors(a, 'src/a.ts', { cap: 5 }).text.split('\n').length, 5);
});

test('stale marking from a fake git status', () => {
  const status = ' M src/b.ts\n?? new.ts\nR  old.ts -> src/c.ts\n';
  assert.deepEqual(parsePorcelain(status), ['src/b.ts', 'new.ts', 'src/c.ts']);
  const t = runQuery(fixture(), 'neighbors', 'src/a.ts', { stale: parsePorcelain(status) }).text;
  assert.ok(t.includes(`src/b.ts [imports] ${STALE_MARK}`));
  assert.ok(!t.includes(`test/a.test.ts [imports, tests] ${STALE_MARK}`));
});

test('context.atlas.query defaults to false and prompts mention the command only when asked', () => {
  assert.equal(DEFAULT_PROJECT_CONFIG.context.atlas.query, false);
  const task = { id: 'T1', title: 't', description: 'd', acceptance: ['a'], deps: [], status: 'pending', notes: [] } as never;
  const w = (atlasQuery?: boolean) => workerPrompt({ goal: 'g', learnings: '', task, others: [], atlasQuery }).prefix;
  assert.ok(!w().includes('orchestra atlas'));
  assert.ok(w(true).includes(ATLAS_QUERY_HINT));
  const j = (atlasQuery?: boolean) => judgePrompt({ task, scenarios: [], workerText: '', tests: null, diff: '', atlasQuery }).prefix;
  assert.ok(!j().includes('orchestra atlas'));
  assert.ok(j(true).includes(ATLAS_QUERY_HINT));
});

test('store.config merges a partial context.atlas with query default', () => {
  const repo = tempRepo().root;
  mkdirSync(join(repo, '.orchestra'), { recursive: true });
  writeFileSync(join(repo, '.orchestra', 'config.json'), JSON.stringify({ context: { atlas: { enabled: true } } }));
  const a = new Store(repo).config().context.atlas;
  assert.equal(a.enabled, true);
  assert.equal(a.query, false);
  assert.equal(a.mapTokens, 1024);
});

test('CLI: atlas find prints a tree when enabled and built, non-zero with a hint when disabled or unbuilt', () => {
  const repo = tempRepo().root;
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'widget.ts'), 'export function makeWidget() { return 1; }\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'widget'], { cwd: repo });
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', timeout: 30000 });
  const off = run('atlas', 'find', 'makeWidget');
  assert.notEqual(off.status, 0);
  assert.match(off.stderr, /disabled.*context\.atlas\.enabled/);
  mkdirSync(join(repo, '.orchestra'), { recursive: true });
  writeFileSync(join(repo, '.orchestra', 'config.json'), JSON.stringify({ context: { atlas: { enabled: true } } }));
  const unbuilt = run('atlas', 'find', 'makeWidget');
  assert.notEqual(unbuilt.status, 0);
  assert.match(unbuilt.stderr, /orchestra atlas build/);
  assert.equal(run('atlas', 'build').status, 0);
  const ok = run('atlas', 'find', 'makeWidget');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /└── src\/widget\.ts\n    └── makeWidget \(function, line 1, exported\)/);
  writeFileSync(join(repo, 'src', 'widget.ts'), 'export function makeWidget() { return 2; }\n');
  assert.ok(run('atlas', 'find', 'makeWidget').stdout.includes(STALE_MARK));
  assert.notEqual(run('atlas', 'find', 'zzzNothing').status, 0);
});

test('CLI: atlas find works from a linked task worktree, using the main checkout config and cache', () => {
  const repo = tempRepo().root;
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'widget.ts'), 'export function makeWidget() { return 1; }\n');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '.orchestra/\n'); // as the conductor does
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'widget'], { cwd: repo });
  mkdirSync(join(repo, '.orchestra'), { recursive: true });
  writeFileSync(join(repo, '.orchestra', 'config.json'), JSON.stringify({ context: { atlas: { enabled: true } } }));
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const inDir = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(inDir(repo, 'atlas', 'build').status, 0);
  // Where the conductor puts task worktrees: inside .orchestra of the main checkout, with a .git file and no .orchestra of its own.
  const wt = join(repo, '.orchestra', 'worktrees', 'r1', 'T1');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'orchestra/r1/T1', wt, 'HEAD'], { cwd: repo });
  assert.equal(existsSync(join(wt, '.orchestra', 'config.json')), false);
  const ok = inDir(wt, 'atlas', 'find', 'makeWidget');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /makeWidget \(function, line 1, exported\)/);
  // Edits in the worktree, not in the main checkout, are what get marked stale.
  writeFileSync(join(wt, 'src', 'widget.ts'), 'export function makeWidget() { return 2; }\n');
  assert.ok(inDir(wt, 'atlas', 'find', 'makeWidget').stdout.includes(STALE_MARK));
  assert.equal(inDir(repo, 'atlas', 'find', 'makeWidget').stdout.includes(STALE_MARK), false);
});
