import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildAtlas, loadOrBuildAtlas, type Atlas } from '../src/atlas.ts';
import { applyExternal, detectCtags, loadGraphify, mergeExternal, parseCtagsJson } from '../src/atlas-external.ts';
import { spawnSync } from 'node:child_process';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { tempRepo } from './helpers.ts';

function repoWithFiles(): { dir: string; sha: string } {
  const dir = tempRepo().root;
  const put = (p: string, t: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  };
  put('src/a.ts', 'export function alpha() {}\n');
  put('src/b.ts', "import { alpha } from './a.ts';\nexport function beta() { alpha(); }\n");
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'files'], { cwd: dir });
  return { dir, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() };
}

const CTAGS = [
  '{"_type":"ptag","name":"JSON_OUTPUT_VERSION","path":"0.0"}',
  '{"_type":"tag","name":"alpha","path":"src/a.ts","line":1,"kind":"function"}',
  '{"_type":"tag","name":"gamma","path":"src/b.ts","line":4,"kind":"method","scope":"Svc"}',
  '{"_type":"tag","name":"weird","path":"src/b.ts","line":9,"kind":"label"}',
  '{"_type":"tag","name":"ghost","path":"gone.ts","line":1,"kind":"function"}',
  'not json',
].join('\n');

const GRAPHIFY = JSON.stringify({
  nodes: [
    { id: 'n1', label: 'a.ts', source_file: 'src/a.ts', file_type: 'code' },
    { id: 'n2', label: 'alpha()', source_file: 'src/a.ts', source_location: 'L1', kind: 'function' },
    { id: 'n3', label: 'beta()', source_file: 'src/b.ts', source_location: 'L2', kind: 'function' },
    { id: 'n4', label: 'Concept', source_file: 'src/b.ts', kind: 'rationale' },
  ],
  links: [
    { source: 'n3', target: 'n2', relation: 'calls' },
    { source: 'n1', target: 'n2', relation: 'contains' },
    { source: 'n3', target: 'n4', relation: 'calls' },
    { source: 'n3', target: 'n2', relation: 'weird_relation' },
  ],
});

// Same schema assertions for every source: unique node ids, valid kinds, edges reference known nodes.
function assertSchema(a: Atlas): void {
  const ids = new Set<string>();
  for (const n of a.nodes) {
    assert.ok(!ids.has(n.id), `duplicate ${n.id}`);
    ids.add(n.id);
    assert.ok(['dir', 'file', 'symbol'].includes(n.kind));
    assert.equal(typeof n.path, 'string');
    if (n.kind === 'symbol') {
      assert.ok(['function', 'class', 'method', 'type', 'const'].includes(n.symKind!));
      assert.ok(n.id.startsWith(`${n.path}#`));
      assert.ok(n.path in a.files);
    }
  }
  for (const e of a.edges) {
    assert.ok(['contains', 'imports', 'references', 'tests'].includes(e.kind));
    assert.ok(ids.has(e.from) && ids.has(e.to), `dangling ${e.from} -> ${e.to}`);
  }
}

test('built-in atlas passes the schema assertions', () => {
  const { dir, sha } = repoWithFiles();
  assertSchema(buildAtlas(dir, sha));
});

test('atlas merged from ctags JSON passes the schema and ignores unknown kinds and paths', () => {
  const { dir, sha } = repoWithFiles();
  const base = buildAtlas(dir, sha);
  const ext = parseCtagsJson(CTAGS);
  assert.deepEqual(ext.nodes.map((n) => n.id), ['src/a.ts#alpha', 'src/b.ts#Svc.gamma', 'gone.ts#ghost']);
  const merged = mergeExternal(base, ext);
  assertSchema(merged);
  assert.ok(merged.nodes.some((n) => n.id === 'src/b.ts#Svc.gamma' && n.symKind === 'method'));
  assert.ok(!merged.nodes.some((n) => n.path === 'gone.ts'));
  assert.equal(merged.nodes.filter((n) => n.id === 'src/a.ts#alpha').length, 1);
});

test('atlas merged from graphify graph.json passes the schema', () => {
  const { dir, sha } = repoWithFiles();
  const g = loadGraphify(dir, (p) => (p.endsWith('graphify-out/graph.json') ? GRAPHIFY : null))!;
  assert.equal(g.source, 'graphify');
  assert.ok(!g.nodes.some((n) => n.name === 'Concept'));
  assert.deepEqual(g.edges.map((e) => `${e.kind}:${e.from}>${e.to}`), ['references:src/b.ts#beta>src/a.ts#alpha', 'contains:src/a.ts>src/a.ts#alpha']);
  const merged = mergeExternal(buildAtlas(dir, sha), g);
  assertSchema(merged);
  assert.ok(merged.edges.some((e) => e.kind === 'references' && e.from === 'src/b.ts#beta'));
});

test('loadGraphify returns null when absent or invalid', () => {
  assert.equal(loadGraphify('/x', () => null), null);
  assert.equal(loadGraphify('/x', () => '{nope'), null);
});

test('detectCtags: universal found, other ctags and missing rejected', () => {
  assert.equal(detectCtags(() => 'Universal Ctags 6.0.0').available, true);
  assert.equal(detectCtags(() => 'Exuberant Ctags 5.8').available, false);
  const r = detectCtags(() => { throw new Error('ENOENT'); });
  assert.equal(r.available, false);
  assert.match(r.reason, /not found/);
});

test('auto with ctags missing falls back to the built-in atlas, logs a reason, throws nothing', () => {
  const { dir, sha } = repoWithFiles();
  const logs: string[] = [];
  const out = loadOrBuildAtlas(dir, sha, { mode: 'auto', exec: () => { throw new Error('ENOENT'); }, read: () => null, log: (m) => logs.push(m) });
  assert.deepEqual(out.nodes, buildAtlas(dir, sha).nodes);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unavailable, using built-in: ctags not found/);
});

test('auto uses ctags when available and off leaves the atlas unchanged', () => {
  const { dir, sha } = repoWithFiles();
  const exec = (_c: string, args: string[]) => (args[0] === '--version' ? 'Universal Ctags 6.1' : CTAGS);
  const withCtags = loadOrBuildAtlas(dir, sha, { mode: 'auto', exec, read: () => null });
  assert.ok(withCtags.nodes.some((n) => n.id === 'src/b.ts#Svc.gamma'));
  assertSchema(withCtags);
  const off = loadOrBuildAtlas(dir, sha, { mode: 'off', exec });
  assert.deepEqual(off, loadOrBuildAtlas(dir, sha));
  assert.ok(!off.nodes.some((n) => n.id === 'src/b.ts#Svc.gamma'));
});

test('explicit graphify mode with no file falls back; ctags failing mid-run degrades', () => {
  const { dir, sha } = repoWithFiles();
  const base = buildAtlas(dir, sha);
  const logs: string[] = [];
  assert.equal(applyExternal(dir, base, { mode: 'graphify', read: () => null, log: (m) => logs.push(m) }), base);
  const exec = (_c: string, args: string[]) => {
    if (args[0] === '--version') return 'Universal Ctags';
    throw new Error('boom');
  };
  assert.equal(applyExternal(dir, base, { mode: 'ctags', exec, log: (m) => logs.push(m) }), base);
  assert.equal(logs.length, 2);
});

test('ctags runs on the atlas commit files in a scratch copy, with excludes, never on the live checkout', () => {
  const { dir, sha } = repoWithFiles();
  // Working-tree drift that must not reach ctags: an edit, and an untracked file.
  writeFileSync(join(dir, 'src/a.ts'), 'export function edited() {}\n');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build/junk.ts'), 'export function junk() {}\n');
  const calls: { args: string[]; cwd: string; input?: string; aText?: string }[] = [];
  const exec = (_c: string, args: string[], cwd: string, input?: string) => {
    if (args[0] === '--version') return 'Universal Ctags 6.1';
    calls.push({ args, cwd, input, aText: existsSync(join(cwd, 'src/a.ts')) ? readFileSync(join(cwd, 'src/a.ts'), 'utf8') : undefined });
    return CTAGS;
  };
  const out = loadOrBuildAtlas(dir, sha, { mode: 'ctags', exec, read: () => null });
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.notEqual(c.cwd, dir, 'not the live checkout');
  assert.ok(c.args.includes('-L') && c.args[c.args.indexOf('-L') + 1] === '-', 'file list on stdin');
  assert.ok(!c.args.includes('-R'), 'no recursive scan');
  for (const e of ['.git', '.orchestra', 'node_modules']) assert.ok(c.args.includes(`--exclude=${e}`), e);
  assert.deepEqual(c.input!.split('\n').filter(Boolean).sort(), ['README.md', 'src/a.ts', 'src/b.ts']);
  assert.equal(c.aText, 'export function alpha() {}\n', 'committed content, not the edited working copy');
  assert.ok(!existsSync(c.cwd), 'scratch copy removed');
  assert.ok(out.nodes.some((n) => n.id === 'src/b.ts#Svc.gamma'));
});

test('ctags output is cached by sha, so a second start does not rescan', () => {
  const { dir, sha } = repoWithFiles();
  let scans = 0;
  const exec = (_c: string, args: string[]) => {
    if (args[0] === '--version') return 'Universal Ctags 6.1';
    scans++;
    return CTAGS;
  };
  const first = loadOrBuildAtlas(dir, sha, { mode: 'ctags', exec, read: () => null });
  const second = loadOrBuildAtlas(dir, sha, { mode: 'ctags', exec, read: () => null });
  assert.equal(scans, 1);
  assert.deepEqual(second.nodes, first.nodes);
});

test('graphify graph.json is read as committed at the atlas commit, not from the working tree', () => {
  const { dir } = repoWithFiles();
  const graph = (name: string) => JSON.stringify({ nodes: [{ id: 'n1', label: `${name}()`, source_file: 'src/a.ts', source_location: 'L1', kind: 'function' }], links: [] });
  mkdirSync(join(dir, 'graphify-out'), { recursive: true });
  writeFileSync(join(dir, 'graphify-out/graph.json'), graph('committedSym'));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'graph'], { cwd: dir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'graphify-out/graph.json'), graph('workingTreeSym'));
  const atlas = loadOrBuildAtlas(dir, sha, { mode: 'graphify' });
  assert.ok(atlas.nodes.some((n) => n.name === 'committedSym'));
  assert.ok(!atlas.nodes.some((n) => n.name === 'workingTreeSym'));
});

test('CLI: atlas find applies context.atlas.external like the conductor does', () => {
  const { dir } = repoWithFiles();
  mkdirSync(join(dir, 'graphify-out'), { recursive: true });
  writeFileSync(join(dir, 'graphify-out/graph.json'), JSON.stringify({ nodes: [{ id: 'n1', label: 'onlyInGraphify()', source_file: 'src/a.ts', source_location: 'L1', kind: 'function' }], links: [] }));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'graph'], { cwd: dir });
  const cfg = (external: string) => writeFileSync(join(dir, '.orchestra', 'config.json'), JSON.stringify({ context: { atlas: { enabled: true, external } } }));
  mkdirSync(join(dir, '.orchestra'), { recursive: true });
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, [cli, ...a], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  cfg('off');
  assert.equal(run('atlas', 'build').status, 0);
  assert.notEqual(run('atlas', 'find', 'onlyInGraphify').status, 0);
  cfg('graphify');
  const ok = run('atlas', 'find', 'onlyInGraphify');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /onlyInGraphify/);
});
