import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRequest, Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { buildSandboxPolicy, preflightSandbox, type ProbeExec } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

const policy = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/tmp', home: '/home/u', hiddenScenarioDir: '/r/.orchestra/hidden', gitCommonDir: '/r/.git' });
const opts = { cwd: '/tmp' };

const result = (stdout: string, extra: object = {}) => ({ status: 0, stdout, stderr: '', ...extra });
const BLOCKED = 'ORCHESTRA_PROBE_BLOCKED\n';
const OPEN = 'ORCHESTRA_PROBE_OPEN\n';
// Decides by probe kind: the network script calls fetch, the read script calls readFileSync.
const fake = (net: string, read: string): ProbeExec => (_c, args) => {
  const script = args.join(' ');
  return result(script.includes('fetch(') ? net : read);
};

test('both probes blocked: ok', () => {
  for (const backend of ['srt', 'claude', 'docker'] as const) {
    assert.deepEqual(preflightSandbox(policy, backend, fake(BLOCKED, BLOCKED), opts), { ok: true, failures: [] });
  }
});

test('network probe succeeds: not ok, names the probe', () => {
  const r = preflightSandbox(policy, 'srt', fake(OPEN, BLOCKED), opts);
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /network probe/);
  assert.equal(r.failures.length, 1);
});

test('read probe succeeds: not ok, names the probe', () => {
  const r = preflightSandbox(policy, 'srt', fake(BLOCKED, OPEN), opts);
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /read probe/);
});

test('wrapper missing or silent: not ok (fail closed)', () => {
  const missing = preflightSandbox(policy, 'srt', () => ({ status: null, stdout: '', stderr: '', error: 'spawn srt ENOENT' }), opts);
  assert.equal(missing.ok, false);
  assert.equal(missing.failures.length, 2);
  assert.match(missing.failures[0], /could not start/);
  assert.equal(preflightSandbox(policy, 'srt', () => result(''), opts).ok, false);
  assert.equal(preflightSandbox(policy, 'srt', () => { throw new Error('boom'); }, opts).ok, false);
});

test('probes run through the srt wrapper and scripts never contain a literal marker', () => {
  const seen: { command: string; args: string[] }[] = [];
  preflightSandbox(policy, 'srt', (command, args) => (seen.push({ command, args }), result(BLOCKED)), opts);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.command === 'srt' && s.args[0] === '--settings'));
  assert.match(seen[1].args.join(' '), /readFileSync/);
  assert.ok(!seen.some((s) => s.args.join(' ').includes('ORCHESTRA_PROBE_OPEN')));
});

function countingRunner(inner: Runner) {
  const calls: string[] = [];
  const runner: Runner = (req: AgentRequest) => (calls.push(req.role), inner(req));
  return { runner, calls };
}

test('sandbox on, network probe succeeds: run aborts before any agent call', async () => {
  const store = tempRepo();
  const { runner, calls } = countingRunner(fakeRunner());
  const run = await runGoal({ store, runner, goal: 'g', sandbox: { backend: 'srt' }, preflightExec: fake(OPEN, BLOCKED) });
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /pre-flight failed.*network probe/);
  assert.deepEqual(calls, []);
  assert.ok(store.events(run.id).some((e) => /Run aborted: .*network probe/.test(e.msg)));
});

test('sandbox on, read probe succeeds: run aborts before any agent call', async () => {
  const store = tempRepo();
  const { runner, calls } = countingRunner(fakeRunner());
  const run = await runGoal({ store, runner, goal: 'g', sandbox: { backend: 'srt' }, preflightExec: fake(BLOCKED, OPEN) });
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /read probe/);
  assert.deepEqual(calls, []);
});

test('sandbox on, both blocked: preflight runs once per run and the run proceeds', async () => {
  const store = tempRepo();
  let n = 0;
  const exec: ProbeExec = (c, a, o) => (n++, fake(BLOCKED, BLOCKED)(c, a, o));
  const run = await runGoal({ store, runner: fakeRunner(), goal: 'g', sandbox: { backend: 'srt' }, preflightExec: exec });
  assert.equal(run.status, 'done');
  assert.equal(n, 2);
});

test('sandbox off: preflight never invoked', async () => {
  const store = tempRepo();
  let n = 0;
  const run = await runGoal({ store, runner: fakeRunner(), goal: 'g', preflightExec: () => (n++, result(OPEN)) });
  assert.equal(run.status, 'done');
  assert.equal(n, 0);
});
