import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { applyContractUpdate, buildContract, contractSha, markPassing, unresolvedAmbiguities } from '../src/contracts.ts';
import { runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { decide } from '../src/guard.ts';
import { analyzeDiff } from '../src/integrity.ts';
import type { Contract } from '../src/contracts.ts';
import { tempRepo } from './helpers.ts';

const tasks = [
  { id: 'T1', acceptance: ['a', 'b'], invariants: ['sorted'] },
  { id: 'T2', acceptance: ['c'] },
];
const clone = (c: Contract): Contract => JSON.parse(JSON.stringify(c));

test('buildContract numbers criteria per task, all failing', () => {
  const c = buildContract(tasks);
  assert.deepEqual(c.criteria.map((x) => x.id), ['T1.c1', 'T1.c2', 'T2.c1']);
  assert.ok(c.criteria.every((x) => x.status === 'failing'));
  assert.deepEqual(c.criteria[0]!.invariants, ['sorted']);
  assert.deepEqual(c.criteria[2]!.invariants, []);
});

test('markPassing flips one criterion and leaves the input untouched', () => {
  const c = buildContract(tasks);
  const next = markPassing(c, 'T1.c2');
  assert.equal(next.criteria[1]!.status, 'passing');
  assert.equal(c.criteria[1]!.status, 'failing');
  assert.throws(() => markPassing(c, 'nope'));
});

test('applyContractUpdate accepts failing->passing and rejects everything else', () => {
  const old = buildContract(tasks);
  assert.equal(applyContractUpdate(old, markPassing(old, 'T1.c1')).ok, true);
  assert.equal(applyContractUpdate(old, clone(old)).ok, true);

  const text = clone(old);
  text.criteria[0]!.text = 'weaker';
  assert.equal(applyContractUpdate(old, text).ok, false);

  const removed = clone(old);
  removed.criteria.pop();
  assert.equal(applyContractUpdate(old, removed).ok, false);

  const added = clone(old);
  added.criteria.push({ id: 'T2.c2', task: 'T2', text: 'x', status: 'passing', invariants: [] });
  assert.equal(applyContractUpdate(old, added).ok, false);

  const inv = clone(old);
  inv.criteria[0]!.invariants = [];
  assert.equal(applyContractUpdate(old, inv).ok, false);

  const renamed = clone(old);
  renamed.criteria[0]!.id = 'T1.c9';
  assert.equal(applyContractUpdate(old, renamed).ok, false);

  const passing = markPassing(old, 'T2.c1');
  const flipped = clone(passing);
  flipped.criteria[2]!.status = 'failing';
  const r = applyContractUpdate(passing, flipped);
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors.join(), /passing -> failing/);
  assert.equal(applyContractUpdate(old, {}).ok, false);
});

test('contractSha is stable for identical input and changes with status', () => {
  assert.equal(contractSha(buildContract(tasks)), contractSha(buildContract(tasks)));
  assert.notEqual(contractSha(buildContract(tasks)), contractSha(markPassing(buildContract(tasks), 'T1.c1')));
});

test('unresolvedAmbiguities flags missing and blank resolutions', () => {
  assert.deepEqual(unresolvedAmbiguities([{ question: 'q1' }, { question: 'q2', resolution: ' ' }, { question: 'q3', resolution: 'ok' }]), ['q1', 'q2']);
  assert.deepEqual(unresolvedAmbiguities(undefined), []);
});

test('guard denies writes to a contract file but allows reads', () => {
  const p = '/repo/.orchestra/runs/r1/contract.json';
  assert.equal(decide('Edit', { file_path: p }).allow, false);
  assert.equal(decide('Write', { file_path: p, content: '{}' }).allow, false);
  assert.equal(decide('Bash', { command: `echo '{}' > ${p}` }).allow, false);
  assert.equal(decide('Bash', { command: `sed -i s/failing/passing/ ${p}` }).allow, false);
  assert.equal(decide('Read', { file_path: p }).allow, true);
  assert.equal(decide('Bash', { command: `cat ${p}` }).allow, true);
});

test('a diff touching a contract file is flagged', () => {
  const diff = 'diff --git a/.orchestra/runs/r1/contract.json b/.orchestra/runs/r1/contract.json\n--- a/.orchestra/runs/r1/contract.json\n+++ b/.orchestra/runs/r1/contract.json\n@@ -1 +1 @@\n-x\n+y\n';
  assert.ok(analyzeDiff(diff).some((f) => f.kind === 'grading-surface'));
});

const open = [{ question: 'Which port?' }, { question: 'Which db?', resolution: 'sqlite' }];
const on = { verification: { contracts: { enabled: true } } } as never;

test('contracts on + unresolved ambiguity fails planning, no task starts', async () => {
  const store = tempRepo(on);
  const run = await runGoal({ store, runner: fakeRunner({ ambiguities: open }), goal: 'g' });
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /Which port\?/);
  assert.doesNotMatch(run.error!, /Which db/);
  assert.equal(run.tasks.length, 0);
  assert.equal(store.ledgerRows().some((r) => r.role === 'worker'), false);
  assert.equal(run.contract, undefined);
});

test('contracts on + resolved ambiguities proceeds and writes the frozen contract', async () => {
  const store = tempRepo(on);
  const run = await runGoal({ store, runner: fakeRunner({ ambiguities: [{ question: 'q', resolution: 'r' }] }), goal: 'g' });
  assert.equal(run.status, 'done');
  assert.equal(run.contract!.path, `runs/${run.id}/contract.json`);
  assert.ok(existsSync(store.path(run.contract!.path)));
  const c = store.readJson<Contract>(run.contract!.path, { criteria: [] });
  assert.deepEqual(c.criteria.map((x) => x.id), ['T1.c1', 'T2.c1', 'T3.c1', 'T4.c1']);
  assert.ok(c.criteria.every((x) => x.status === 'failing'));
  assert.equal(run.contract!.sha256, contractSha(c));
});

test('contracts off ignores unresolved ambiguities', async () => {
  const store = tempRepo();
  const run = await runGoal({ store, runner: fakeRunner({ ambiguities: open }), goal: 'g' });
  assert.equal(run.status, 'done');
  assert.equal(run.contract, undefined);
  assert.equal(existsSync(store.path(`runs/${run.id}/contract.json`)), false);
});
