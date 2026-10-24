import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildArgs, buildCommand, makeClaudeRunner, type AgentRequest } from '../src/agent.ts';
import { resolveSandbox } from '../src/cli.ts';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { buildSandboxPolicy, scrubWorkerEnv } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

const policyFor = (wt: string) =>
  buildSandboxPolicy({ worktree: wt, tmpDir: '/tmp', home: '/home/u', hiddenScenarioDir: '/repo/.orchestra/scenarios', gitCommonDir: '/repo/.git' });

const baseReq = (cwd: string): AgentRequest => ({ role: 'worker', prompt: 'p', system: 's', cwd, model: 'm', budgetUsd: 1 });

// Fake spawn: records the call, emits a success result line, closes.
function fakeSpawn() {
  const calls: { command: string; args: string[]; opts: any }[] = [];
  const fn = ((command: string, args: string[], opts: any) => {
    calls.push({ command, args, opts });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\n');
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as any;
  return { fn, calls };
}

test('without sandbox the spawn is plain claude with process.env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-sb-'));
  const { fn, calls } = fakeSpawn();
  const res = await makeClaudeRunner(fn)(baseReq(dir));
  assert.equal(res.ok, true);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, buildArgs(baseReq(dir)));
  assert.equal(calls[0].opts.env, process.env);
  assert.equal(existsSync(join(dir, '.claude')), false);
});

test('sandbox claude passes fail-closed settings inline and never touches the worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-sb-'));
  // Hostile pre-existing worker/repo settings must not influence what we pass.
  mkdirSync(join(dir, '.claude'));
  const before = JSON.stringify({ sandbox: { excludedCommands: ['curl'] }, permissions: { allow: ['Bash(*)'] }, hooks: { x: 1 } });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), before);
  const req = { ...baseReq(dir), sandbox: { policy: policyFor(dir), backend: 'claude' as const } };
  const cmd = buildCommand(req);
  assert.equal(cmd.command, 'claude');
  assert.deepEqual(cmd.args, buildArgs(req));
  assert.equal(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'), before);
  const s = JSON.parse(cmd.args[cmd.args.indexOf('--settings') + 1]);
  assert.ok(s.hooks.PreToolUse, 'guard hook still present');
  assert.ok(s.permissions.deny.some((d: string) => d.startsWith('Read(//home/u/.ssh')));
  assert.equal(s.permissions.allow, undefined);
  assert.equal(s.sandbox.excludedCommands, undefined);
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.sandbox.failIfUnavailable, true);
});

test('sandbox srt spawns srt with the claude args after it and a settings file outside the worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-sb-'));
  const sdir = mkdtempSync(join(tmpdir(), 'orch-sb-settings-'));
  const { fn, calls } = fakeSpawn();
  const req = { ...baseReq(dir), sandbox: { policy: policyFor(dir), backend: 'srt' as const, settingsDir: sdir } };
  await makeClaudeRunner(fn)(req);
  const c = calls[0];
  assert.equal(c.command, 'srt');
  const i = c.args.indexOf('claude');
  assert.ok(i > 0);
  assert.deepEqual(c.args.slice(i + 1), buildArgs(req));
  const file = c.args[c.args.indexOf('--settings') + 1];
  assert.ok(file.startsWith(sdir));
  assert.equal(existsSync(join(dir, '.claude')), false);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(s.network.allowedDomains.includes('api.anthropic.com'));
  assert.ok(s.filesystem.allowWrite.includes(dir));
  assert.equal(s.sandbox, undefined);
  // Written fresh each call, no merge with stale content.
  writeFileSync(file, '{"stale":true}');
  buildCommand(req);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).stale, undefined);
});

test('worker env passed to spawn has no push or publish tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-sb-'));
  const { fn, calls } = fakeSpawn();
  const env = scrubWorkerEnv({ PATH: '/bin', GH_TOKEN: 'a', NPM_TOKEN: 'b', SSH_AUTH_SOCK: 'c', ANTHROPIC_API_KEY: 'k' });
  await makeClaudeRunner(fn)({ ...baseReq(dir), env });
  const got = calls[0].opts.env;
  assert.equal(got.GH_TOKEN, undefined);
  assert.equal(got.NPM_TOKEN, undefined);
  assert.equal(got.SSH_AUTH_SOCK, undefined);
  assert.equal(got.ANTHROPIC_API_KEY, 'k');
});

test('conductor sandboxes workers only and scrubs env; off leaves requests untouched', async () => {
  const { runGoal } = await import('../src/conductor.ts');
  const { fakeRunner } = await import('../src/fake.ts');
  process.env.GH_TOKEN = 'secret';
  try {
    for (const on of [false, true]) {
      const store = tempRepo();
      const inner = fakeRunner({ stepMs: 0 });
      const seen: AgentRequest[] = [];
      await runGoal({
        store,
        goal: 'Add a thing',
        runner: (req) => (seen.push(req), inner(req)),
        sandbox: on ? { backend: 'claude', allowedHosts: ['registry.npmjs.org'] } : undefined,
      });
      assert.ok(seen.some((r) => r.role === 'worker'));
      for (const r of seen) {
        if (!on) {
          assert.equal(r.sandbox, undefined);
          assert.equal(r.env, undefined);
        } else {
          assert.equal(r.env?.GH_TOKEN, undefined);
          assert.equal(Boolean(r.sandbox), r.role === 'worker');
        }
      }
      if (on) {
        const w = seen.find((r) => r.role === 'worker');
        assert.ok(w?.sandbox?.policy.network.allowedHosts.includes('registry.npmjs.org'));
      }
    }
  } finally {
    delete process.env.GH_TOKEN;
  }
});

test('sandboxed run leaves no settings in any session cwd, so judges are not sandboxed by the worker config', async () => {
  const { runGoal } = await import('../src/conductor.ts');
  const { fakeRunner } = await import('../src/fake.ts');
  for (const backend of ['claude', 'srt'] as const) {
    const store = tempRepo();
    const inner = fakeRunner({ stepMs: 0 });
    const seen: { role: string; sandboxed: boolean; localSettings: boolean }[] = [];
    await runGoal({
      store,
      goal: 'Add a thing',
      runner: (req) => (seen.push({ role: req.role, sandboxed: Boolean(req.sandbox), localSettings: existsSync(join(req.cwd, '.claude', 'settings.local.json')) }), inner(req)),
      sandbox: { backend },
      preflightExec: () => ({ status: 0, stdout: 'ORCHESTRA_PROBE_BLOCKED', stderr: '' }),
    });
    assert.ok(seen.some((r) => r.role === 'judge'), 'a judge ran');
    assert.ok(seen.every((r) => !r.localSettings), 'no .claude/settings.local.json in any cwd');
    assert.ok(seen.filter((r) => r.role !== 'worker').every((r) => !r.sandboxed));
  }
});

test('worker policy resolves the git common dir once, not per agent call', async () => {
  const { Conductor } = await import('../src/conductor.ts');
  const { fakeRunner } = await import('../src/fake.ts');
  const store = tempRepo();
  const c: any = new Conductor({ store, runner: fakeRunner({ stepMs: 0 }), goal: 'x', sandbox: { backend: 'claude' } } as any);
  const first = c.workerPolicy('/wt/a').gitCommonDir;
  assert.ok(first.endsWith('.git'));
  // With the repo unreadable, a second call can only succeed from the memo.
  rmSync(join(store.root, '.git', 'HEAD'));
  assert.equal(c.workerPolicy('/wt/b').gitCommonDir, first);
});

test('resolveSandbox: modes and defaults', () => {
  const none = { backend: 'none' as const, srt: false, claude: false, reason: 'no sandbox' };
  const srt = { backend: 'srt' as const, srt: true, claude: false, reason: 'srt found' };
  assert.deepEqual(resolveSandbox([], none), { backend: null, unattended: false });
  assert.deepEqual(resolveSandbox(['--sandbox', 'auto'], srt), { backend: 'srt', unattended: false });
  assert.deepEqual(resolveSandbox(['--unattended'], srt), { backend: 'srt', unattended: true });
});

test('CLI: --unattended without a sandbox exits 1 and makes no agent calls; bad --sandbox lists values', () => {
  const store = tempRepo();
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'run', 'Do thing', ...args], {
      cwd: store.root,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ORCHESTRA_RUNNER: 'fake', ORCHESTRA_SANDBOX_DETECT: 'none' },
    });

  for (const args of [['--unattended'], ['--unattended', '--sandbox', 'off']]) {
    const r = run(...args);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /srt/);
    assert.match(r.stderr, /bwrap/);
    assert.match(r.stderr, /sandbox-exec/);
  }
  assert.equal(store.currentRunId() === null || store.currentRunId() === '', true);

  const bad = run('--sandbox', 'bogus');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /auto, srt, claude, docker, off/);
});
