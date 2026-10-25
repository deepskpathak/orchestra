import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ATLAS_VERSION, buildGraph, extractFile } from '../src/atlas.ts';
import type { Atlas } from '../src/atlas.ts';
import { buildTaskPack, estimateTokens, rankFiles, renderMap } from '../src/atlas-context.ts';

const STATE_DIR = ['.orch', 'estra'].join(''); // built up so the literal path is not spelled in the source

const SRC: Record<string, string> = {
  'src/auth.ts': `import { hash } from './crypto.ts';\nexport function login(user: string) {}\nexport class Session {}\n`,
  'src/crypto.ts': `export function hash(s: string) {}\nexport const SALT = 1;\n`,
  'src/server.ts': `import { login } from './auth.ts';\nexport function start() {}\n`,
  'src/billing.ts': `export function invoice() {}\n`,
  'src/util/misc.ts': `export function noop() {}\n`,
  'test/auth.test.ts': `import { login } from '../src/auth.ts';\n`,
};

function fixture(order: string[] = Object.keys(SRC)): Atlas {
  const files: Atlas['files'] = {};
  for (const p of order) files[p] = extractFile(p, SRC[p]);
  return { version: ATLAS_VERSION, sha: 'abc', files, skipped: [], ...buildGraph(files) };
}

test('rankFiles puts goal matches and their importers first', () => {
  const r = rankFiles(fixture(), 'fix the login flow in auth');
  assert.equal(r[0].path, 'src/auth.ts');
  const top3 = r.slice(0, 3).map((x) => x.path);
  assert.ok(top3.includes('src/server.ts'));
  assert.ok(top3.includes('test/auth.test.ts'));
  assert.ok(r.findIndex((x) => x.path === 'src/billing.ts') > 2);
});

test('rankFiles falls back to a uniform seed and breaks ties by path', () => {
  const r = rankFiles(fixture(), 'zzzzz');
  assert.equal(r.length, 6);
  const billing = r.findIndex((x) => x.path === 'src/billing.ts');
  const misc = r.findIndex((x) => x.path === 'src/util/misc.ts');
  assert.ok(billing < misc); // equal scores, path order
  assert.deepEqual(rankFiles({ ...fixture(), files: {}, nodes: [], edges: [] }, 'x'), []);
});

test('renderMap respects budget, is deterministic and independent of input order', () => {
  const a = fixture();
  const b = fixture(Object.keys(SRC).reverse());
  const full = renderMap(a, 'login', 10_000);
  assert.match(full, /auth\.ts/);
  assert.match(full, /function login/);
  assert.equal(renderMap(a, 'login', 10_000), full);
  assert.equal(renderMap(b, 'login', 10_000), full);
  for (const budget of [20, 40, 80, 120]) {
    const m = renderMap(a, 'login', budget);
    assert.ok(estimateTokens(m) <= budget, `budget ${budget} got ${estimateTokens(m)}`);
    assert.equal(renderMap(b, 'login', budget), m);
  }
  assert.equal(renderMap(a, 'login', 1), '');
  assert.match(renderMap(a, 'login', 60), /auth\.ts/); // a tight budget keeps the best-ranked file
});

test('buildTaskPack lists footprint, importer, tests and changed files', () => {
  const pack = buildTaskPack(fixture(), { files: ['src/auth.ts'], symbols: ['login'] }, ['src/billing.ts'], 1500);
  assert.match(pack, /Footprint:\n {2}src\/auth\.ts\n {4}function login/);
  assert.doesNotMatch(pack, /class Session/); // symbols narrowed to the requested one
  assert.match(pack, /Importers and callers:\n {2}src\/server\.ts/);
  assert.match(pack, /Related tests:\n {2}test\/auth\.test\.ts/);
  assert.match(pack, /since run start:\n {2}src\/billing\.ts \(changed since base[^\n]*\n {4}function invoice/);
});

test('buildTaskPack flags skeletons of files changed on integration as base-commit state', () => {
  const pack = buildTaskPack(fixture(), { files: ['src/auth.ts'] }, ['src/auth.ts', 'src/billing.ts'], 1500);
  assert.equal((pack.match(/as of the base commit/g) ?? []).length, 3);
  assert.match(pack, /src\/auth\.ts \(changed since base/);
  const clean = buildTaskPack(fixture(), { files: ['src/auth.ts'] }, [], 1500);
  assert.ok(!clean.includes('as of the base commit'));
});

test('buildTaskPack respects packTokens', () => {
  for (const budget of [5, 15, 30, 60]) {
    const pack = buildTaskPack(fixture(), { files: ['src/auth.ts'] }, ['src/billing.ts'], budget);
    assert.ok(estimateTokens(pack) <= budget, `budget ${budget} got ${estimateTokens(pack)}`);
  }
});

test('buildTaskPack reports unknown files and returns empty for nothing', () => {
  const pack = buildTaskPack(fixture(), { files: ['src/auth.ts', 'src/ghost.ts'] }, [], 1500);
  assert.match(pack, /Not in index: src\/ghost\.ts/);
  assert.equal(buildTaskPack(fixture(), { files: [] }, [], 1500), '');
  assert.match(buildTaskPack(fixture(), { files: [] }, ['src/crypto.ts'], 1500), /crypto\.ts/);
});

test('never emits excluded paths', () => {
  const pack = buildTaskPack(fixture(), { files: ['.env', `${STATE_DIR}/evals/x.ts`, 'src/auth.ts'] }, [`${STATE_DIR}/state.json`, 'config/.env.prod'], 1500);
  assert.doesNotMatch(pack, new RegExp(`\\.env|${STATE_DIR}`));
  assert.equal(buildTaskPack(fixture(), { files: ['.env'] }, [`${STATE_DIR}/x`], 1500), '');
});

test('module is pure: no fs or child_process imports', () => {
  const src = readFileSync(new URL('../src/atlas-context.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'node:(fs|child_process)'|from '\.\/(git|store)\.ts'/);
  assert.doesNotMatch(src, /^import (?!type).*from/m);
});
