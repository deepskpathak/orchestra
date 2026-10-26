import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { test } from 'node:test';
import type { AgentRequest, Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { DEFAULT_IMAGE } from '../src/container.ts';
import { buildSandboxPolicy, preflightSandbox, PROBE_ARGV_POSITIONAL, PROBE_TRAILING_ARGS, type ProbeExec } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

const policy = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/tmp', home: '/home/u', hiddenScenarioDir: '/r/.orchestra/hidden', gitCommonDir: '/r/.git' });
const opts = { cwd: '/tmp' };

const result = (stdout: string, extra: object = {}) => ({ status: 0, stdout, stderr: '', ...extra });
const BLOCKED = 'ORCHESTRA_PROBE_BLOCKED\n';
const OPEN = 'ORCHESTRA_PROBE_OPEN\n';
// Decides by probe kind: the network script calls fetch, the read script calls readFileSync.
// The unsandboxed positive control (command "node") always reaches the network here.
const fake = (net: string, read: string): ProbeExec => (c, args) => {
  if (c === 'node') return result(OPEN);
  const script = args.join(' ');
  return result(script.includes('fetch(') ? net : read);
};

test('both probes blocked: ok', () => {
  for (const backend of ['srt', 'claude', 'docker'] as const) {
    const r = preflightSandbox(policy, backend, fake(BLOCKED, BLOCKED), opts);
    assert.deepEqual([r.ok, r.failures], [true, []]);
    // docker defaults to network none, which always warns about the model API
    assert.equal(r.warnings.length, backend === 'docker' ? 1 : 0);
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

test('control runs unsandboxed first; if it also fails the result is inconclusive, not BLOCKED', () => {
  const seen: string[] = [];
  const exec: ProbeExec = (c) => (seen.push(c), result(BLOCKED));
  const r = preflightSandbox(policy, 'srt', exec, opts);
  assert.equal(seen[0], 'node');
  assert.equal(seen.filter((c) => c === 'srt').length, 1, 'sandboxed network probe skipped, read probe still runs');
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
  assert.match(r.warnings[0], /inconclusive.*no connectivity/);
  assert.match(r.warnings[0], /NOT verified/);
  // A control that cannot even start is the same: never claim BLOCKED.
  const r2 = preflightSandbox(policy, 'srt', (c) => (c === 'node' ? { status: null, stdout: '', stderr: '', error: 'ENOENT' } : result(BLOCKED)), opts);
  assert.match(r2.warnings[0], /inconclusive/);
});

test('control reaches the network and the sandbox also reaches it: still a failure', () => {
  const r = preflightSandbox(policy, 'claude', fake(OPEN, BLOCKED), opts);
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /network probe succeeded/);
});

test('wrapper missing or silent: not ok (fail closed)', () => {
  const missing = preflightSandbox(policy, 'srt', () => ({ status: null, stdout: '', stderr: '', error: 'spawn srt ENOENT' }), opts);
  assert.equal(missing.ok, false);
  const withControl = (f: ProbeExec): ProbeExec => (c, a, o) => (c === 'node' ? result(OPEN) : f(c, a, o));
  const missing2 = preflightSandbox(policy, 'srt', withControl(() => ({ status: null, stdout: '', stderr: '', error: 'spawn srt ENOENT' })), opts);
  assert.equal(missing2.failures.length, 2);
  assert.match(missing2.failures[0], /could not start/);
  assert.equal(preflightSandbox(policy, 'srt', withControl(() => result('')), opts).ok, false);
  assert.equal(preflightSandbox(policy, 'srt', withControl(() => { throw new Error('boom'); }), opts).ok, false);
});

test('srt probes get a srt-shaped settings file and claude probes the Claude shape', () => {
  const read = (backend: 'srt' | 'claude') => {
    let shape: any;
    const exec: ProbeExec = (_c, args) => {
      const f = args[args.indexOf('--settings') + 1];
      if (f && !shape) shape = JSON.parse(readFileSync(f, 'utf8'));
      return result(BLOCKED);
    };
    preflightSandbox(policy, backend, exec, opts);
    return shape;
  };
  assert.ok(read('srt').filesystem.denyRead);
  assert.equal(read('claude').sandbox.enabled, true);
});

test('docker network none warns that the model API is unreachable; a chosen network skips the probe', () => {
  const calls: string[] = [];
  const exec: ProbeExec = (c, a) => (calls.push(c + ' ' + a.join(' ')), result(c === 'node' ? OPEN : BLOCKED));
  const none = preflightSandbox(policy, 'docker', exec, opts);
  assert.equal(none.ok, true);
  assert.ok(none.warnings.some((w) => /network is none.*api\.anthropic\.com/.test(w)));
  calls.length = 0;
  const custom = preflightSandbox(policy, 'docker', exec, { ...opts, docker: { network: 'orch-egress' } });
  assert.equal(custom.ok, true);
  assert.ok(custom.warnings.some((w) => /orch-egress.*allow-list/.test(w)));
  assert.ok(!calls.some((c) => c.includes('fetch(')), 'no network probe on a user-chosen network');
  assert.ok(calls.every((c) => !c.startsWith('node ')), 'no control either');
  assert.ok(calls.some((c) => c.includes('--network=orch-egress')));
});

test('docker read canary lives outside every mounted path; srt canary stays in the denied tmp dir', () => {
  const canaryOf = (backend: 'srt' | 'docker') => {
    let path = '';
    preflightSandbox(policy, backend, (_c, args) => {
      const m = args.join(' ').match(/readFileSync\("([^"]+)"\)/);
      if (m) path = m[1];
      return result(BLOCKED);
    }, opts);
    return path;
  };
  const d = canaryOf('docker');
  assert.ok(d.endsWith('canary.txt'));
  // opts.cwd and the policy tmp dir are mounted; the canary must not be under either.
  for (const mounted of ['/tmp', '/wt', '/r/.git']) assert.ok(!d.startsWith(mounted + '/'), `${d} under ${mounted}`);
  assert.match(canaryOf('srt'), /orchestra-preflight-/);
});

test('docker read probe is skipped with a warning when no unmounted dir is usable', () => {
  const mounted = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/var/tmp', home: '/home/u', hiddenScenarioDir: '/h', gitCommonDir: homedir() });
  const calls: string[] = [];
  const r = preflightSandbox(mounted, 'docker', (_c, args) => (calls.push(args.join(' ')), result(_c === 'node' ? OPEN : BLOCKED)), opts);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'control + docker network probe, no read probe');
  assert.ok(r.warnings.some((w) => /read probe skipped/.test(w)));
});

test('probes run through the srt wrapper and scripts never contain a literal marker', () => {
  const seen: { command: string; args: string[] }[] = [];
  preflightSandbox(policy, 'srt', (command, args) => (seen.push({ command, args }), result(command === 'node' ? OPEN : BLOCKED)), opts);
  const wrapped = seen.filter((s) => s.command === 'srt');
  assert.equal(wrapped.length, 2);
  assert.equal(seen.length, 3, 'plus the unsandboxed control');
  assert.ok(wrapped.every((s) => s.args[0] === '--settings'));
  assert.match(wrapped[1].args.join(' '), /readFileSync/);
  assert.ok(!seen.some((s) => s.args.join(' ').includes('ORCHESTRA_PROBE_OPEN')));
});

// Strips the wrapper prefix and really runs the inner argv (no shell), like srt or docker would hand it
// to node. `tweak` lets a test drop or alter trailing args the way a mangling wrapper would.
const realInner = (backend: 'srt' | 'docker', tweak: (inner: string[]) => string[] = (a) => a): ProbeExec => (c, args) => {
  if (c === 'node') return result(OPEN);
  const inner = backend === 'srt' ? args.slice(args.indexOf('--') + 1) : args.slice(args.indexOf(DEFAULT_IMAGE) + 1);
  const [cmd, ...rest] = tweak(inner);
  const r = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};
const argvFailures = (r: { failures: string[] }) => r.failures.filter((f) => /argv was not passed through/.test(f));

test('probe args end with node -e script, a positional and worker-like trailing args with no -- (srt and docker)', () => {
  assert.ok(PROBE_TRAILING_ARGS.includes('--settings') && PROBE_TRAILING_ARGS.includes('-p'));
  const json = PROBE_TRAILING_ARGS[PROBE_TRAILING_ARGS.indexOf('--settings') + 1];
  assert.ok(json.includes('"') && json.includes(' ') && json.includes('$'));
  for (const backend of ['srt', 'docker'] as const) {
    const seen: string[][] = [];
    preflightSandbox(policy, backend, (c, args) => (c !== 'node' && seen.push(args), result(c === 'node' ? OPEN : BLOCKED)), opts);
    assert.ok(seen.length >= 1);
    for (const args of seen) {
      const n = args.length - PROBE_TRAILING_ARGS.length;
      assert.deepEqual(args.slice(n), PROBE_TRAILING_ARGS);
      assert.deepEqual([args[n - 4], args[n - 3], args[n - 1]], ['node', '-e', PROBE_ARGV_POSITIONAL]);
      // The only `--` is srt's own, before node: nothing ends srt's option parsing ahead of the trailing
      // --settings, so a srtArgs that lost its `--` would see it, like with a real worker (#74).
      const inner = args.slice(args.indexOf('node'));
      assert.ok(!inner.includes('--'), inner.join(' '));
    }
  }
});

test('claude probe args carry no trailing probe args', () => {
  const seen: string[][] = [];
  preflightSandbox(policy, 'claude', (c, args) => (c !== 'node' && seen.push(args), result(c === 'node' ? OPEN : BLOCKED)), opts);
  assert.ok(seen.length >= 1);
  for (const args of seen) {
    assert.equal(args[0], '-p');
    assert.ok(!args.includes('--'));
    assert.equal(args.filter((a) => a === '--settings').length, 1);
    assert.ok(!args.some((a) => PROBE_TRAILING_ARGS.slice(1).includes(a) && a !== '--settings' && a !== '-p'));
    assert.deepEqual(args.slice(-2), ['--output-format', 'text']);
  }
});

test('intact argv really executed via spawnSync: no argv failure', () => {
  for (const backend of ['srt', 'docker'] as const) {
    const r = preflightSandbox(policy, backend, realInner(backend), opts);
    assert.deepEqual(argvFailures(r), [], `${backend}: ${r.failures.join('; ')}`);
  }
});

test('a dropped trailing arg fails pre-flight with the argv reason', () => {
  for (const backend of ['srt', 'docker'] as const) {
    const r = preflightSandbox(policy, backend, realInner(backend, (a) => a.filter((x) => x !== '-p')), opts);
    assert.equal(r.ok, false);
    assert.ok(argvFailures(r).length >= 1, r.failures.join('; '));
    assert.match(argvFailures(r)[0], new RegExp(`${backend} mangled or dropped arguments`));
  }
});

test('an altered JSON value (dollar sign stripped, or split on spaces) fails with the argv reason', () => {
  const strip = (a: string[]) => a.map((x, i) => (i > 2 ? x.replace(/\$/g, '') : x)); // leave node, -e and the script alone
  const split = (a: string[]) => a.flatMap((x, i) => (x.startsWith('{') && a[i - 1] === '--settings' ? x.split(' ') : [x]));
  for (const tweak of [strip, split]) {
    const r = preflightSandbox(policy, 'srt', realInner('srt', tweak), opts);
    assert.equal(r.ok, false);
    assert.ok(argvFailures(r).length >= 1, r.failures.join('; '));
  }
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
  assert.equal(n, 3, 'control + two wrapped probes');
});

test('sandbox off: preflight never invoked', async () => {
  const store = tempRepo();
  let n = 0;
  const run = await runGoal({ store, runner: fakeRunner(), goal: 'g', preflightExec: () => (n++, result(OPEN)) });
  assert.equal(run.status, 'done');
  assert.equal(n, 0);
});
