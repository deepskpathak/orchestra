import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { Store } from '../src/store.ts';
import { writeLearnings } from '../src/learnings.ts';
import { auditCases, buildAddedCase, buildHarvestedCase, filterByTags, harvestableRun, regressionSuite, significantLines } from '../src/evalcases.ts';
import type { Run } from '../src/types.ts';

const run = (over: Partial<Run> = {}): Run => ({ id: 'r1', goal: 'Fix the parser crash on empty input', harness: 'v1', kind: 'goal', status: 'failed', startedAt: 1, endedAt: 2, baseRef: 'abc123', tasks: [], costUsd: 0, active: [], ...over });

test('buildAddedCase makes a tagged case with a deterministic id and rejects bad input', () => {
  const c = buildAddedCase({ goal: '  Add retry to client  ', base: 'abc', regression: true, tags: ['net'] }, [], 1000);
  assert.equal(c.id, 'm-add-retry-to-client');
  assert.equal(c.goal, 'Add retry to client');
  assert.deepEqual(c.tags, ['net', 'regression']);
  assert.equal(c.createdAt, 1000);
  assert.equal(c.check, null);
  assert.throws(() => buildAddedCase({ goal: ' ', base: 'abc' }, [], 1), /goal is required/);
  assert.throws(() => buildAddedCase({ goal: 'x', base: 'abc', id: 'dup' }, ['dup'], 1), /already exists/);
  assert.throws(() => buildAddedCase({ goal: 'x', base: 'abc', id: 'a/b' }, [], 1), /Invalid case id/);
  assert.notEqual(buildAddedCase({ goal: 'Add retry to client', base: 'abc' }, ['m-add-retry-to-client'], 5).id, 'm-add-retry-to-client');
});

test('harvest uses the human fix diff as reference and only accepts failed or low-satisfaction goal runs', () => {
  const diff = 'diff --git a/p.ts b/p.ts\n+++ b/p.ts\n@@ -1 +1 @@\n+if (input.length === 0) return emptyResult();';
  const reads: string[][] = [];
  const c = buildHarvestedCase(run(), 'fixsha', (b, f) => (reads.push([b, f]), diff), 'npm test', [], 50);
  assert.deepEqual(reads, [['abc123', 'fixsha']]);
  assert.equal(c.id, 'h-r1');
  assert.equal(c.base, 'abc123');
  assert.equal(c.reference, diff);
  assert.equal(c.check, 'npm test');
  assert.deepEqual(c.tags, ['human-fix', 'regression']);
  assert.equal(c.harvestedFrom, 'r1');
  assert.ok(buildHarvestedCase(run({ status: 'done', satisfaction: 0.4 }), 'f', () => diff, null, [], 1));
  assert.match(harvestableRun(run({ status: 'done', satisfaction: 0.9 }))!, /harvested automatically/);
  assert.match(harvestableRun(run({ kind: 'eval' }))!, /eval run/);
  assert.match(harvestableRun(run({ baseRef: undefined }))!, /no recorded base/);
  assert.match(harvestableRun(run({ endedAt: undefined }))!, /not finished/);
  assert.throws(() => buildHarvestedCase(run(), 'f', () => '  ', null, [], 1), /no change/);
  assert.throws(() => buildHarvestedCase(run(), 'f', () => diff, null, ['h-r1'], 1), /already harvested/);
});

test('tag filters and the regression suite', () => {
  const cases = [
    { id: 'a', goal: 'g', base: 'b', tags: ['regression', 'x'] },
    { id: 'b', goal: 'g', base: 'b', tags: ['x'] },
    { id: 'c', goal: 'g', base: 'b' },
  ];
  assert.deepEqual(regressionSuite(cases).map((c) => c.id), ['a']);
  assert.deepEqual(filterByTags(cases, ['x']).map((c) => c.id), ['a', 'b']);
  assert.deepEqual(filterByTags(cases, ['x', 'regression']).map((c) => c.id), ['a']);
  assert.equal(filterByTags(cases, []).length, 3);
});

test('significantLines keeps long added lines and skips diff headers', () => {
  assert.deepEqual(significantLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+short\n+const answer = computeTheAnswer(42);'), ['const answer = computeTheAnswer(42);']);
});

test('significantLines uses only added lines of a diff and normalises whitespace', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' const existing = loadTheConfigFile();', '-const removed = oldImplementation();', '+const   added  =   newImplementation();'].join('\n');
  assert.deepEqual(significantLines(diff), ['const added = newImplementation();']);
  assert.deepEqual(significantLines('  plain   reference text that is long enough  '), ['plain reference text that is long enough']);
});

test('audit does not flag a goal quoting existing code from a context line, but flags a quoted added line', () => {
  const reference = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' const existing = loadTheConfigFile();', '-const removed = oldImplementation();', '+const added = newImplementation();'].join('\n');
  const ok = { id: 'ctx', goal: 'The function const existing = loadTheConfigFile(); crashes on empty input', base: 'b', reference };
  const bad = { id: 'added', goal: 'Please write const added = newImplementation(); in x', base: 'b', reference };
  const removed = { id: 'removed', goal: 'Delete const removed = oldImplementation(); from x', base: 'b', reference };
  assert.deepEqual(auditCases([ok, removed]), []);
  assert.deepEqual(auditCases([bad]).map((f) => f.kind), ['goal-reference']);
});

test('audit flags diffs and quoted reference lines in goals, and quoted solutions in lessons', () => {
  const ref = '+const answer = computeTheAnswer(42);';
  const cases = [
    { id: 'clean', goal: 'Make the answer correct', base: 'b', reference: ref },
    { id: 'diffy', goal: 'Apply this:\ndiff --git a/x b/x\n+++ b/x', base: 'b' },
    { id: 'quote', goal: 'Please write const answer = computeTheAnswer(42); somewhere', base: 'b', reference: ref },
    { id: 'lessoned', goal: 'Make the answer correct', base: 'b', reference: ref },
    { id: 'bad', goal: '', base: 'b' } as never,
  ];
  assert.deepEqual(auditCases(cases.slice(0, 1)), []);
  const f = auditCases(cases, [{ lesson: 'Use const answer = computeTheAnswer(42); to fix it' }]);
  const kinds = f.map((x) => `${x.caseId}:${x.kind}`).sort();
  assert.deepEqual(kinds, ['bad:invalid', 'clean:lesson-reference', 'diffy:goal-diff', 'lessoned:lesson-reference', 'quote:goal-reference', 'quote:lesson-reference']);
  const lg = auditCases([{ id: 'g', goal: 'Rename the frobnicate function to frob', base: 'b' }], [{ lesson: 'When asked: rename the frobnicate function to frob, grep first' }]);
  assert.deepEqual(lg.map((x) => x.kind), ['lesson-goal']);
  assert.deepEqual(auditCases([]), []);
});

// ---- CLI against temp repos only ----

const CLI = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
function repo(initialised = true): { dir: string; head: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-evalcases-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const head = g('rev-parse', 'HEAD');
  if (initialised) {
    mkdirSync(join(dir, '.orchestra'));
    writeFileSync(join(dir, '.orchestra', 'config.json'), '{}');
  }
  return { dir, head, store: new Store(dir) };
}
const cli = (dir: string, ...args: string[]) => spawnSync(process.execPath, [CLI, 'evals', ...args], { cwd: dir, encoding: 'utf8', timeout: 20000 });

test('evals list: empty set, add, filter by regression', () => {
  const { dir, head } = repo();
  assert.match(cli(dir).stdout, /No Factory Eval cases yet/);
  const a = cli(dir, 'add', 'Fix', 'the', 'crash', '--regression', '--check', 'npm test');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /added eval case m-fix-the-crash/);
  const file = JSON.parse(readFileSync(join(dir, '.orchestra', 'evals', 'm-fix-the-crash.json'), 'utf8'));
  assert.equal(file.base, head);
  assert.equal(file.check, 'npm test');
  assert.deepEqual(file.tags, ['regression']);
  assert.equal(cli(dir, 'add', 'Another goal').status, 0);
  const l = cli(dir, 'list');
  assert.match(l.stdout, /Fix the crash/);
  assert.match(l.stdout, /Another goal/);
  const r = cli(dir, 'list', '--regression');
  assert.match(r.stdout, /Fix the crash/);
  assert.doesNotMatch(r.stdout, /Another goal/);
  assert.match(cli(dir, '--regression').stdout, /Fix the crash/);
  assert.match(cli(dir, 'list', '--tag', 'nope').stdout, /No Factory Eval cases tagged nope/);
});

test('evals add rejects missing goal, bad base, duplicate id and leaky goals', () => {
  const { dir } = repo();
  for (const args of [['add'], ['add', 'g', '--base', 'nosuchref'], ['add', 'g', '--bogus'], ['add', 'g', '--tag']]) {
    const r = cli(dir, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.ok(r.stderr.startsWith('orchestra: '));
  }
  assert.equal(cli(dir, 'add', 'g', '--id', 'x').status, 0);
  assert.match(cli(dir, 'add', 'g2', '--id', 'x').stderr, /already exists/);
  const leak = cli(dir, 'add', 'Apply: diff --git a/x b/x\n+++ b/x', '--id', 'leaky');
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /leaks its own solution/);
  assert.equal(existsSync(join(dir, '.orchestra', 'evals', 'leaky.json')), false);
});

test('evals add --from-run harvests a failed run with the human fix as reference', () => {
  const { dir, head, store } = repo();
  writeFileSync(join(dir, 'a.txt'), 'one\nhuman fixed line number two\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'human fix'], { cwd: dir });
  const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  store.saveRun(run({ id: 'rfail', baseRef: head }));
  store.saveRun(run({ id: 'rgood', status: 'done', satisfaction: 0.95, baseRef: head }));
  const ok = cli(dir, 'add', '--from-run', 'rfail', '--fix', fix);
  assert.equal(ok.status, 0, ok.stderr);
  const c = JSON.parse(readFileSync(join(dir, '.orchestra', 'evals', 'h-rfail.json'), 'utf8'));
  assert.equal(c.base, head);
  assert.match(c.reference, /human fixed line number two/);
  assert.deepEqual(c.tags, ['human-fix', 'regression']);
  assert.match(cli(dir, 'add', '--from-run', 'rfail', '--fix', fix).stderr, /already harvested/);
  assert.match(cli(dir, 'harvest', '--from-run', 'rgood', '--fix', fix).stderr, /harvested automatically/);
  assert.match(cli(dir, 'add', '--from-run', 'nope', '--fix', fix).stderr, /No run nope/);
  assert.match(cli(dir, 'add', '--from-run', 'rfail', '--fix', 'deadbeef').stderr, /does not exist/);
  assert.match(cli(dir, 'add', '--from-run', 'rfail').stderr, /needs both/);
  assert.match(cli(dir, 'add', '--fix', fix).stderr, /needs both/);
});

test('evals add --from-run errors clearly when the fix does not descend from the run base, and uses stdout only', () => {
  const { dir, head, store } = repo();
  execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\nside branch change here\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'side'], { cwd: dir });
  const side = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  // The run started from a commit the fix does not descend from.
  execFileSync('git', ['checkout', '-q', head], { cwd: dir });
  writeFileSync(join(dir, 'b.txt'), 'diverged base\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'other'], { cwd: dir });
  const other = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  store.saveRun(run({ id: 'rdiv', baseRef: other }));
  const r = cli(dir, 'add', '--from-run', 'rdiv', '--fix', side);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not descend from base/);
  assert.equal(existsSync(join(dir, '.orchestra', 'evals', 'h-rdiv.json')), false);
  // A tree object is a valid object but not a commit that exists as a fix.
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(cli(dir, 'add', '--from-run', 'rdiv', '--fix', tree).status, 1);
});

test('evals audit: exit 0 on empty set, on clean set and on an uninitialised repo; exit 1 with findings', () => {
  const { dir } = repo();
  const empty = cli(dir, 'audit');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No eval cases to audit/);

  assert.equal(cli(dir, 'add', 'Make the answer correct', '--id', 'ok1', '--reference', '+const answer = computeTheAnswer(42);').status, 0);
  const clean = cli(dir, 'audit');
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /no solution leakage found/);

  const store = new Store(dir);
  writeLearnings(store, [{ role: 'worker', lesson: 'Just write const answer = computeTheAnswer(42); there', evidence: [{ run: 'r1' }], hits: 0 }], 'r1');
  const bad = cli(dir, 'audit');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /ok1  \[lesson-reference\]/);

  const un = repo(false);
  const r = cli(un.dir, 'audit');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not initialised/);
  assert.equal(existsSync(join(un.dir, '.orchestra')), false);
  const nogit = mkdtempSync(join(tmpdir(), 'orch-nogit-'));
  const n = cli(nogit, 'audit');
  assert.equal(n.status, 0, n.stderr);
});

test('evals unknown subcommand is rejected without side effects; other commands still require init', () => {
  const { dir } = repo();
  const r = cli(dir, 'frobnicate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown evals subcommand "frobnicate"\. Known: list, add, harvest, audit, ablation/);
  assert.equal(existsSync(join(dir, '.orchestra', 'evals')), false);
  assert.match(cli(repo(false).dir, 'list').stderr, /not initialised/);
});
