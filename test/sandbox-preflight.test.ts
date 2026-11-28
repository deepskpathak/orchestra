import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRequest, Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { DEFAULT_IMAGE } from '../src/container.ts';
import { buildSandboxPolicy, preflightSandbox, PROBE_ARGV_POSITIONAL, PROBE_PROMPT, PROBE_TRAILING_ARGS, probeWorkerArgs, type ProbeExec } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

const policy = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/tmp', home: '/home/u', hiddenScenarioDir: '/r/.orchestra/hidden', gitCommonDir: '/r/.git' });
const opts = { cwd: '/tmp' };

// Docker pre-flight writes its read canary under a host base dir (/var/tmp or $HOME by default), which
// is not writable inside a sandbox. Tests inject a base from a dedicated temp root instead. The policy's
// mounted tmp dir lives in the same root but is a sibling, so the base is outside every mount even on
// Linux where tmpdir() itself is /tmp.
function dockerEnv() {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-preflight-test-'));
  const mountedTmp = join(root, 'mounted-tmp');
  const base = join(root, 'canary-base');
  mkdirSync(mountedTmp);
  mkdirSync(base);
  // A real worktree dir: the docker worktree probe writes a marker into it.
  const wt = join(root, 'wt');
  mkdirSync(wt);
  const pol = buildSandboxPolicy({ worktree: wt, tmpDir: mountedTmp, home: '/home/u', hiddenScenarioDir: '/r/.orchestra/hidden', gitCommonDir: '/r/.git' });
  return { root, mountedTmp, base, wt, pol, o: { cwd: wt, canaryBases: [base] }, done: () => rmSync(root, { recursive: true, force: true }) };
}

const result = (stdout: string, extra: object = {}) => ({ status: 0, stdout, stderr: '', ...extra });
const BLOCKED = 'ORCHESTRA_PROBE_BLOCKED\n';
const OPEN = 'ORCHESTRA_PROBE_OPEN\n';
// Decides by probe kind: the network script calls fetch, the read script calls readFileSync.
// The unsandboxed positive control (command "node") always reaches the network here.
const VISIBLE = 'ORCHESTRA_PROBE_VISIBLE\n';
// The docker worktree probe reads a nonce file the host wrote into the worktree; these fakes report it visible.
const isVisibleProbe = (script: string) => script.includes("'utf8');console.log(s===");
// Wraps a test exec so the docker worktree probe sees its marker; everything else goes to the wrapped exec.
const withVisible = (exec: ProbeExec): ProbeExec => (c, args, o) => (isVisibleProbe(args.join(' ')) ? result(VISIBLE) : exec(c, args, o));
const fake = (net: string, read: string): ProbeExec => (c, args) => {
  if (c === 'node') return result(OPEN);
  const script = args.join(' ');
  if (isVisibleProbe(script)) return result(VISIBLE);
  return result(script.includes('fetch(') ? net : read);
};

test('both probes blocked: ok', () => {
  const d = dockerEnv();
  try {
    for (const backend of ['srt', 'claude', 'docker'] as const) {
      const r = backend === 'docker' ? preflightSandbox(d.pol, backend, fake(BLOCKED, BLOCKED), d.o) : preflightSandbox(policy, backend, fake(BLOCKED, BLOCKED), opts);
      assert.deepEqual([r.ok, r.failures], [true, []]);
      // docker defaults to network none, which always warns about the model API
      assert.equal(r.warnings.length, backend === 'docker' ? 1 : 0);
    }
  } finally {
    d.done();
  }
});

test('allowLocalBinding: srt and claude warn that localhost is widened; docker warns that it is ignored', () => {
  const local = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/tmp', home: '/home/u', hiddenScenarioDir: '/r/.orchestra/hidden', gitCommonDir: '/r/.git', allowLocalBinding: true });
  for (const backend of ['srt', 'claude'] as const) {
    const r = preflightSandbox(local, backend, fake(BLOCKED, BLOCKED), opts);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /allowLocalBinding is on.*macOS.*any localhost port.*bypassing the proxy/);
  }
  const d = dockerEnv();
  try {
    const pol = { ...d.pol, network: { ...d.pol.network, allowLocalBinding: true } };
    const r = preflightSandbox(pol, 'docker', fake(BLOCKED, BLOCKED), d.o);
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /allowLocalBinding is ignored with --sandbox docker/.test(w)));
    assert.ok(!r.warnings.some((w) => /widened/.test(w)));
  } finally {
    d.done();
  }
  // Off by default: no warning (the "both probes blocked" test pins the exact count for each backend).
  assert.ok(!preflightSandbox(policy, 'srt', fake(BLOCKED, BLOCKED), opts).warnings.some((w) => /allowLocalBinding/.test(w)));
});

test('sandbox on with allowLocalBinding: the widened-localhost warning reaches the run log', async () => {
  const store = tempRepo();
  const run = await runGoal({ store, runner: fakeRunner(), goal: 'g', sandbox: { backend: 'srt', allowLocalBinding: true }, preflightExec: fake(BLOCKED, BLOCKED) });
  assert.equal(run.status, 'done');
  assert.ok(store.events(run.id).some((e) => /Sandbox pre-flight warning: sandbox\.allowLocalBinding is on/.test(e.msg)));
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

test('srt probes get a srt-shaped settings file and claude probes carry the Claude shape inline, like workers', () => {
  const read = (backend: 'srt' | 'claude') => {
    let shape: any;
    const exec: ProbeExec = (c, args) => {
      const v = args[args.indexOf('--settings') + 1];
      // srt reads a settings file; a claude worker gets its sandbox block inline in --settings JSON.
      if (c !== 'node' && v && !shape) shape = backend === 'srt' ? JSON.parse(readFileSync(v, 'utf8')) : JSON.parse(v);
      return result(BLOCKED);
    };
    preflightSandbox(policy, backend, exec, opts);
    return shape;
  };
  assert.ok(read('srt').filesystem.denyRead);
  const claude = read('claude');
  assert.equal(claude.sandbox.enabled, true);
  assert.ok(claude.hooks.PreToolUse, 'the worker guard hook rides along, as in a worker session');
});
test('docker network none warns that the model API is unreachable; a chosen network skips the probe', () => {
  const d = dockerEnv();
  try {
    const calls: string[] = [];
    const exec: ProbeExec = withVisible((c, a) => (calls.push(c + ' ' + a.join(' ')), result(c === 'node' ? OPEN : BLOCKED)));
    const none = preflightSandbox(d.pol, 'docker', exec, d.o);
    assert.equal(none.ok, true);
    assert.ok(none.warnings.some((w) => /network is none.*api\.anthropic\.com/.test(w)));
    calls.length = 0;
    const custom = preflightSandbox(d.pol, 'docker', exec, { ...d.o, docker: { network: 'orch-egress' } });
    assert.equal(custom.ok, true);
    assert.ok(custom.warnings.some((w) => /orch-egress.*allow-list/.test(w)));
    assert.ok(!calls.some((c) => c.includes('fetch(')), 'no network probe on a user-chosen network');
    assert.ok(calls.every((c) => !c.startsWith('node ')), 'no control either');
    assert.ok(calls.some((c) => c.includes('--network=orch-egress')));
  } finally {
    d.done();
  }
});

test('docker read canary lives in the injected base and outside every mounted path; srt canary stays in the denied tmp dir', () => {
  const d = dockerEnv();
  try {
    let written = false;
    const canaryOf = (backend: 'srt' | 'docker') => {
      let path = '';
      const [pol, o] = backend === 'docker' ? [d.pol, d.o] : [policy, opts];
      preflightSandbox(pol, backend, (_c, args) => {
        const m = args.join(' ').match(/readFileSync\("([^"]+)"\)/);
        if (m) path = m[1];
        if (m && backend === 'docker') written = existsSync(m[1]); // preflight removes it afterwards
        return result(BLOCKED);
      }, o);
      return path;
    };
    const c = canaryOf('docker');
    assert.ok(c.endsWith('canary.txt'));
    assert.ok(c.startsWith(d.base + '/'), `${c} not under injected base ${d.base}`);
    assert.ok(written, 'canary was written while the probe ran');
    // opts.cwd, the policy tmp dir and the git common dir are mounted; the canary must not be under any.
    for (const mounted of [d.mountedTmp, '/wt', '/r/.git']) assert.ok(!c.startsWith(mounted + '/'), `${c} under ${mounted}`);
    assert.match(canaryOf('srt'), /orchestra-preflight-/);
  } finally {
    d.done();
  }
});

test('docker canary candidates: an empty list takes the no-usable-canary path; a covered base is skipped', () => {
  const d = dockerEnv();
  try {
    for (const bases of [[], [d.mountedTmp]]) {
      const calls: string[] = [];
      const r = preflightSandbox(d.pol, 'docker', withVisible((c, args) => (calls.push(args.join(' ')), result(c === 'node' ? OPEN : BLOCKED))), { ...d.o, canaryBases: bases });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 2, 'control + docker network probe, no read probe');
      assert.ok(r.warnings.some((w) => /read probe skipped/.test(w)));
    }
  } finally {
    d.done();
  }
});

test('docker read probe is skipped with a warning when no unmounted dir is usable', () => {
  const mounted = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/var/tmp', home: '/home/u', hiddenScenarioDir: '/h', gitCommonDir: homedir() });
  const calls: string[] = [];
  const r = preflightSandbox(mounted, 'docker', withVisible((_c, args) => (calls.push(args.join(' ')), result(_c === 'node' ? OPEN : BLOCKED))), opts);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'control + docker network probe, no read probe (the worktree probe is answered by withVisible)');
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
// to node. `tweak` lets a test drop or alter trailing args the way a mangling wrapper would. The
// unsandboxed control reports no connectivity, so pre-flight skips the network probe and only the read
// probe runs for real: no test makes an outbound request.
const realInner = (backend: 'srt' | 'docker', tweak: (inner: string[]) => string[] = (a) => a): ProbeExec => (c, args) => {
  if (c === 'node') return result(BLOCKED);
  assert.ok(!args.join(' ').includes('fetch('), 'the network probe must never be executed for real');
  const inner = backend === 'srt' ? args.slice(args.indexOf('--') + 1) : args.slice(args.indexOf(DEFAULT_IMAGE) + 1);
  const [cmd, ...rest] = tweak(inner);
  const r = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};
const argvFailures = (r: { failures: string[] }) => r.failures.filter((f) => /argv was not passed through/.test(f));

test('probe args end with node -e script, a positional and the real worker args with no -- (srt and docker)', () => {
  for (const backend of ['srt', 'docker'] as const) {
    const seen: string[][] = [];
    preflightSandbox(policy, backend, (c, args) => (c !== 'node' && seen.push(args), result(c === 'node' ? OPEN : BLOCKED)), { ...opts, model: 'haiku' });
    assert.ok(seen.length >= 1);
    for (const args of seen) {
      const inner = args.slice(args.indexOf('node'));
      assert.deepEqual([inner[0], inner[1], inner[3]], ['node', '-e', PROBE_ARGV_POSITIONAL]);
      const trailing = inner.slice(4);
      // Built by buildArgs, so the same flags a worker gets, in the same order.
      assert.deepEqual(trailing, probeWorkerArgs(opts.cwd, { policy, backend }, 'haiku'), backend);
      assert.deepEqual(trailing.slice(0, 2), ['-p', PROBE_PROMPT]);
      assert.equal(trailing[trailing.indexOf('--model') + 1], 'haiku');
      const json = trailing[trailing.indexOf('--settings') + 1];
      assert.ok(json.includes('"') && json.includes(' ') && PROBE_PROMPT.includes('$'));
      // The only `--` is srt's own, before node: nothing ends srt's option parsing ahead of the trailing
      // --settings, so a srtArgs that lost its `--` would see it, like with a real worker (#74).
      assert.ok(!inner.includes('--'), inner.join(' '));
    }
  }
});
test('claude probe is a worker-shaped claude session whose Bash command carries the trailing probe args', () => {
  assert.ok(Object.isFrozen(PROBE_TRAILING_ARGS));
  const seen: { c: string; args: string[] }[] = [];
  preflightSandbox(policy, 'claude', (c, args) => (c !== 'node' && seen.push({ c, args }), result(c === 'node' ? OPEN : BLOCKED)), { ...opts, model: 'haiku' });
  assert.equal(seen.length, 2);
  for (const { c, args } of seen) {
    assert.equal(c, 'claude');
    assert.equal(args[0], '-p');
    assert.equal(args.filter((a) => a === '--settings').length, 1);
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(args.includes('--max-budget-usd') && args.includes('--max-turns'));
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash');
    assert.ok(args[1].includes(` ${PROBE_ARGV_POSITIONAL} '--settings' `), args[1]);
  }
});

// Stands in for Claude Code: takes the command from the probe prompt, lets `mangle` play the part of a
// wrapper or a model that rewrites it, and runs it for real through bash like the Bash tool. The network
// probe and the control are never executed.
const claudeBash = (mangle: (cmd: string) => string = (x) => x): ProbeExec => (c, args) => {
  if (c === 'node') return result(BLOCKED);
  const cmd = args[1].split('\n').slice(1).join('\n');
  assert.ok(!cmd.includes('fetch('), 'the network probe must never be executed for real');
  const r = spawnSync('bash', ['-c', mangle(cmd)], { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};

test('claude probe: intact Bash argv passes; a dropped or re-quoted arg fails with the argv reason', () => {
  assert.deepEqual(argvFailures(preflightSandbox(policy, 'claude', claudeBash(), opts)), []);
  const dropP = (cmd: string) => cmd.replace(" '-p' ", ' ');
  const unquoted = (cmd: string) => {
    const quoted = `'${PROBE_TRAILING_ARGS[3]}'`; // the prompt-like value: spaces, double quotes and $USER
    assert.ok(cmd.includes(quoted), cmd);
    return cmd.replace(quoted, PROBE_TRAILING_ARGS[3]); // unquoted, bash splits it and expands $USER
  };
  for (const mangle of [dropP, unquoted]) {
    const r = preflightSandbox(policy, 'claude', claudeBash(mangle), opts);
    assert.equal(r.ok, false);
    assert.ok(argvFailures(r)[0]?.includes("Claude Code's Bash sandbox wrapper, or the model retyping the command"), r.failures.join('; '));
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
    const culprit = backend === 'docker' ? 'the docker wrapper or the image entrypoint' : 'the srt wrapper';
    assert.ok(argvFailures(r)[0].includes(`(${culprit} altered or dropped arguments)`), argvFailures(r)[0]);
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

// A stand-in for srt's CLI, modelled on how it parses argv: commander with allowUnknownOption and no
// passThroughOptions, so its own options are recognised anywhere until a literal `--`, the last
// --settings wins, and unknown options and operands are kept in order as the command. As in commander's
// parseOptions, once an unknown option has been seen a later `--` is kept as part of the command
// instead of being consumed. Like srt it refuses
// to start when the settings path is not a readable srt settings file, which is how the #74 bug showed
// up. It enforces nothing: it runs the read probe for real through `bash -c` with shell-quoted argv (as
// srt does on macOS and Linux) and reports the canary read as blocked, so the test isolates argv
// handling. The network probe and the control are never executed, so no request leaves the machine.
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const commanderSrt = (argvOf: (args: string[]) => string[]): ProbeExec => (c, raw) => {
  if (c === 'node') return result(OPEN);
  const args = argvOf(raw);
  let settings: string | undefined;
  const command: string[] = [];
  let sawUnknown = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { command.push(...(sawUnknown ? args.slice(i) : args.slice(i + 1))); break; }
    if (args[i] === '--settings') { settings = args[++i]; continue; }
    if (args[i].startsWith('-')) sawUnknown = true;
    command.push(args[i]);
  }
  try {
    if (!JSON.parse(readFileSync(settings ?? '', 'utf8')).filesystem) throw new Error('not an srt settings file');
  } catch (e) {
    return { status: 1, stdout: '', stderr: `Error: could not load settings ${settings}: ${(e as Error).message}` };
  }
  if (command.join(' ').includes('fetch(')) return result(BLOCKED);
  const r = spawnSync('bash', ['-c', command.map(shq).join(' ')], { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, stdout: (r.stdout ?? '').replaceAll('ORCHESTRA_PROBE_OPEN', 'ORCHESTRA_PROBE_BLOCKED'), stderr: r.stderr ?? '', error: r.error?.message };
};

test('#74 regression: a srtArgs without its -- fails pre-flight against a commander-style srt', () => {
  const intact = preflightSandbox(policy, 'srt', commanderSrt((a) => a), opts);
  assert.deepEqual([intact.ok, intact.failures, intact.warnings], [true, [], []]);
  // Reconstructs the regressed srtArgs (['srt', '--settings', path, command, ...args]) by dropping the
  // wrapper's own `--`, which is the first one in the argv. srt then takes the probe's trailing
  // --settings <json> as its settings path, cannot load it, and never starts the probe.
  const dropFirstDashDash = (a: string[]) => a.filter((x, i) => !(x === '--' && i === a.indexOf('--')));
  const regressed = preflightSandbox(policy, 'srt', commanderSrt(dropFirstDashDash), opts);
  assert.equal(regressed.ok, false);
  assert.equal(regressed.failures.length, 2, regressed.failures.join('; '));
  assert.ok(regressed.failures.every((f) => /inconclusive/.test(f)), regressed.failures.join('; '));
});

test('docker with both blocking probes skipped still checks argv through the worktree probe', () => {
  // /var/tmp and the home dir are both mounted here, so docker has nowhere to put the read canary.
  const mounted = buildSandboxPolicy({ worktree: '/wt', tmpDir: '/var/tmp', home: '/home/u', hiddenScenarioDir: '/h', gitCommonDir: homedir() });
  const calls: string[] = [];
  const exec: ProbeExec = withVisible((c) => (calls.push(c), result(BLOCKED)));
  // A user network skips the network probe; no connectivity (control BLOCKED) skips it under none.
  for (const docker of [{ network: 'orch-egress' }, {}]) {
    calls.length = 0;
    const r = preflightSandbox(mounted, 'docker', exec, { ...opts, docker });
    assert.equal(r.ok, true, r.failures.join('; '));
    assert.ok(!r.warnings.some((w) => /argv pass-through was NOT verified/.test(w)), r.warnings.join('; '));
  }
});

test('docker worktree probe: an empty mount fails pre-flight, and an altered argv is reported as such', () => {
  const d = dockerEnv();
  try {
    // Every blocking probe passes, as it would against an empty bind mount, but the marker is not visible.
    const empty = preflightSandbox(d.pol, 'docker', (c) => (c === 'node' ? result(OPEN) : result(BLOCKED)), d.o);
    assert.equal(empty.ok, false);
    assert.ok(empty.failures.some((f) => /worktree probe: the worktree .* is not visible inside the container/.test(f) && /colima/.test(f)), empty.failures.join('; '));
    const argv = preflightSandbox(d.pol, 'docker', (c, args) => (c === 'node' ? result(OPEN) : isVisibleProbe(args.join(' ')) ? result('ORCHESTRA_PROBE_ARGV_MISMATCH\n') : result(BLOCKED)), d.o);
    assert.ok(argv.failures.some((f) => /worktree probe: worker argv was not passed through/.test(f)), argv.failures.join('; '));
    // The marker is removed whatever the outcome.
    assert.deepEqual(readdirSync(d.wt).filter((n) => n.startsWith('.orchestra-preflight-')), []);
    // A worktree the host cannot write to fails closed.
    const unwritable = preflightSandbox(d.pol, 'docker', fake(BLOCKED, BLOCKED), { ...d.o, cwd: join(d.root, 'missing') });
    assert.ok(unwritable.failures.some((f) => /could not write a marker/.test(f)), unwritable.failures.join('; '));
  } finally {
    d.done();
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
