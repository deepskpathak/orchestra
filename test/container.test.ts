import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCommand, type AgentRequest } from '../src/agent.ts';
import { resolveSandbox } from '../src/cli.ts';
import { containerEnvNames, dockerArgs } from '../src/container.ts';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { buildSandboxPolicy, scrubWorkerEnv } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

const input = { worktree: '/wt/T1', tmpDir: '/tmp', image: 'img:1', envNames: ['ANTHROPIC_API_KEY'], gitCommonDir: '/repo/.git' };

test('dockerArgs: network none, mounts, workdir, env names only', () => {
  const a = dockerArgs(input);
  assert.deepEqual(a.slice(0, 4), ['docker', 'run', '--rm', '--network=none']);
  assert.ok(a.includes('/wt/T1:/wt/T1:rw'));
  assert.ok(a.includes('/repo/.git/hooks:/repo/.git/hooks:ro'));
  assert.ok(a.includes('/repo/.git/config:/repo/.git/config:ro'));
  assert.equal(a[a.indexOf('-w') + 1], '/wt/T1');
  assert.equal(a[a.length - 1], 'img:1');
  assert.ok(!a.some((x) => x.includes('=')  && x.startsWith('-e')));
  assert.ok(!a.some((x) => /GH_TOKEN|NPM_TOKEN/.test(x)));
  assert.ok(!a.includes('--runtime=runsc'));
  assert.ok(dockerArgs({ ...input, gvisor: true }).includes('--runtime=runsc'));
});

test('containerEnvNames keeps model env only', () => {
  const env = scrubWorkerEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_FOO: '1' });
  assert.deepEqual(containerEnvNames(env), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_FOO']);
});

test('resolveSandbox docker: needs docker, carries image and gvisor', () => {
  const probe = { backend: 'none' as const, srt: false, claude: false, docker: true, reason: 'r' };
  assert.deepEqual(resolveSandbox(['--sandbox', 'docker', '--sandbox-image', 'x:1', '--gvisor'], probe), { backend: 'docker', unattended: false, image: 'x:1', gvisor: true });
});

test('CLI: --sandbox docker without docker exits 1 with a hint', () => {
  const store = tempRepo();
  const r = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'orchestra.ts'), 'run', 'Do thing', '--sandbox', 'docker'], {
    cwd: store.root,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ORCHESTRA_RUNNER: 'fake', ORCHESTRA_SANDBOX_DETECT: 'none' },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /docker/);
  assert.match(r.stderr, /Install docker/);
});

test('e2e: fixture goal completes through the conductor with a docker spawn shim', async () => {
  const { runGoal } = await import('../src/conductor.ts');
  const { fakeRunner } = await import('../src/fake.ts');
  const store = tempRepo();
  const inner = fakeRunner({ stepMs: 0 });
  const shim: { command: string; args: string[] }[] = [];
  process.env.GH_TOKEN = 'secret';
  try {
    const run = await runGoal({
      store,
      goal: 'Add a thing',
      sandbox: { backend: 'docker', image: 'img:1', gvisor: true },
      // Pre-flight probes get a fake exec so no real docker is needed.
      preflightExec: () => ({ status: 0, stdout: 'ORCHESTRA_PROBE_BLOCKED\n', stderr: '' }),
      runner: (req: AgentRequest) => {
        if (req.sandbox) shim.push(buildCommand(req));
        return inner(req);
      },
    });
    assert.equal(run.status, 'done');
  } finally {
    delete process.env.GH_TOKEN;
  }
  assert.ok(shim.length > 0);
  for (const c of shim) {
    assert.equal(c.command, 'docker');
    assert.ok(c.args.includes('--network=none'));
    assert.ok(c.args.includes('--runtime=runsc'));
    assert.ok(c.args.includes('img:1'));
    assert.ok(!c.args.some((a) => a.includes('secret') || a === 'GH_TOKEN'));
  }
});
