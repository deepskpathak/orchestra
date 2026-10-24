import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSandboxPolicy, claudeSandboxSettings, detectSandbox, scrubWorkerEnv, srtArgs } from '../src/sandbox.ts';

const fake = (platform: string, ...present: string[]) => ({ platform, which: (c: string) => present.includes(c) });
const HIDDEN = ['', 'r', '.orchestra', 'scen'].join('/');

test('detectSandbox picks srt, claude or none', () => {
  assert.equal(detectSandbox(fake('linux', 'srt')).backend, 'srt');
  assert.equal(detectSandbox(fake('darwin', 'srt', 'sandbox-exec')).backend, 'srt');
  assert.equal(detectSandbox(fake('darwin', 'sandbox-exec')).backend, 'claude');
  assert.equal(detectSandbox(fake('linux', 'bwrap', 'socat')).backend, 'claude');
  assert.equal(detectSandbox(fake('darwin')).backend, 'none');
  assert.equal(detectSandbox(fake('win32')).backend, 'none');
});

test('detectSandbox: linux with bwrap but no socat is none', () => {
  const d = detectSandbox(fake('linux', 'bwrap'));
  assert.equal(d.backend, 'none');
  assert.deepEqual(d.available, ['bwrap']);
  assert.match(d.reason, /socat/);
});

const policy = () =>
  buildSandboxPolicy({
    worktree: '/w/t1',
    tmpDir: '/tmp/o',
    home: '/home/u',
    hiddenScenarioDir: HIDDEN,
    gitCommonDir: '/r/.git',
    allowedHosts: ['registry.npmjs.org'],
  });

test('policy confines writes, denies secret reads and git hooks/config, limits network', () => {
  const p = policy();
  assert.deepEqual(p.write.allow, ['/w/t1', '/tmp/o', '/r/.git']);
  assert.equal(p.gitCommonDir, '/r/.git');
  // hooks and config are denied inside the writable common dir
  assert.ok(p.write.deny.every((d) => d.startsWith('/r/.git/')));
  for (const d of ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.npmrc', '.netrc']) {
    assert.ok(p.read.deny.includes(`/home/u/${d}`), d);
  }
  assert.ok(p.read.deny.includes(HIDDEN));
  assert.ok(p.read.deny.some((g) => g.endsWith('.env') || g.endsWith('.env.*')));
  assert.deepEqual(p.write.deny, ['/r/.git/hooks', '/r/.git/config']);
  assert.deepEqual(p.network.allowedHosts, ['api.anthropic.com', 'registry.npmjs.org']);
  const bare = buildSandboxPolicy({ worktree: 'a', tmpDir: 'b', home: 'c', hiddenScenarioDir: 'd', gitCommonDir: 'e' });
  assert.deepEqual(bare.network.allowedHosts, ['api.anthropic.com']);
});

test('claudeSandboxSettings is fail-closed and serialisable', () => {
  const s = claudeSandboxSettings(policy()) as any;
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.deepEqual(s.sandbox.network.allowedDomains, ['api.anthropic.com', 'registry.npmjs.org']);
  assert.ok(s.permissions.deny.includes('Read(/home/u/.ssh)'));
  assert.ok(s.permissions.deny.includes('Edit(/r/.git/hooks)'));
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('srtArgs builds the argv', () => {
  assert.deepEqual(srtArgs(policy(), '/w/s.json', 'claude', ['-p', 'hi']), ['srt', '--settings', '/w/s.json', 'claude', '-p', 'hi']);
});

test('scrubWorkerEnv drops push/publish creds, keeps model creds, does not mutate', () => {
  const env: Record<string, string> = {
    PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_X: '1',
    GH_TOKEN: 'a', GITHUB_TOKEN: 'a', GH_ENTERPRISE_TOKEN: 'a', GITLAB_TOKEN: 'a', NPM_TOKEN: 'a', NODE_AUTH_TOKEN: 'a',
    NPM_CONFIG__AUTH: 'a', NPM_CONFIG__AUTHTOKEN: 'a', TWINE_PASSWORD: 'a', PYPI_TOKEN: 'a', CARGO_REGISTRY_TOKEN: 'a',
    SSH_AUTH_SOCK: 'a', GIT_ASKPASS: 'a', SSH_ASKPASS: 'a', AWS_SECRET_ACCESS_KEY: 'a', AWS_SESSION_TOKEN: 'a',
  };
  const before = { ...env };
  const out = scrubWorkerEnv(env);
  assert.deepEqual(Object.keys(out).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_X', 'HOME', 'PATH']);
  assert.deepEqual(env, before);
});
