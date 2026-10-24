// Pure sandbox helpers: detection, policy, settings mapping, env scrubbing. No IO at import time;
// every external probe is injected so tests run on machines without bwrap, socat, srt or sandbox-exec.
//
// Boundary model: the OS sandbox is the real control. src/guard.ts is a deny-list hook and stays as a
// backstop (defence in depth), because a python/node/git-remote command can bypass its regexes.

import { join } from 'node:path';

export type SandboxBackend = 'srt' | 'claude' | 'none';

export interface SandboxDetection {
  backend: SandboxBackend;
  available: string[];
  reason: string;
}

export interface DetectDeps {
  platform: string;
  which: (cmd: string) => boolean;
}

// srt (Anthropic sandbox-runtime) wins when present. Otherwise Claude Code's built-in sandbox needs
// bubblewrap AND socat on Linux (socat bridges the network proxy), or sandbox-exec on macOS.
export function detectSandbox(deps: DetectDeps): SandboxDetection {
  const wanted = deps.platform === 'darwin' ? ['srt', 'sandbox-exec'] : deps.platform === 'linux' ? ['srt', 'bwrap', 'socat'] : ['srt'];
  const available = wanted.filter((c) => deps.which(c));
  const has = (c: string) => available.includes(c);
  if (has('srt')) return { backend: 'srt', available, reason: 'srt found' };
  if (deps.platform === 'darwin' && has('sandbox-exec')) return { backend: 'claude', available, reason: 'sandbox-exec found' };
  if (deps.platform === 'linux' && has('bwrap') && has('socat')) return { backend: 'claude', available, reason: 'bwrap and socat found' };
  const missing = wanted.filter((c) => !has(c));
  const reason =
    deps.platform === 'darwin' || deps.platform === 'linux'
      ? `no sandbox: missing ${missing.join(', ')}`
      : `no sandbox: unsupported platform ${deps.platform}`;
  return { backend: 'none', available, reason };
}

export const MODEL_API_HOST = 'api.anthropic.com';

export interface SandboxPolicy {
  write: { allow: string[]; deny: string[] };
  read: { deny: string[] };
  network: { allowedHosts: string[] };
}

export interface PolicyInput {
  worktree: string;
  tmpDir: string;
  home: string;
  hiddenScenarioDir: string; // the judge-only scenario directory under .orchestra, supplied by the caller
  gitCommonDir: string;
  allowedHosts?: string[];
}

// Credential locations and secret files a worker never needs. ".env*" is a glob, matched anywhere.
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.npmrc', '.netrc'];
const ENV_GLOBS = ['**/.env', '**/.env.*'];

export function buildSandboxPolicy(i: PolicyInput): SandboxPolicy {
  const hosts = [MODEL_API_HOST, ...(i.allowedHosts ?? [])];
  return {
    write: {
      allow: [i.worktree, i.tmpDir],
      // Worktrees share the common git dir; hooks and config there are code-execution vectors
      // for the orchestrator, so workers get read-only access.
      deny: [join(i.gitCommonDir, 'hooks'), join(i.gitCommonDir, 'config')],
    },
    read: { deny: [...HOME_SECRETS.map((p) => join(i.home, p)), ...ENV_GLOBS, i.hiddenScenarioDir] },
    network: { allowedHosts: [...new Set(hosts)] },
  };
}

// Claude Code settings. Keys from the Claude Code sandbox docs (ref [69]): sandbox.enabled,
// sandbox.allowUnsandboxedCommands, sandbox.network.allowedDomains, permissions.deny with
// Read(...)/Edit(...) rules. Inferred (not confirmed in docs): sandbox.failIfUnavailable as the
// fail-closed switch, and sandbox.filesystem.{allowWrite,denyWrite,denyRead}. Unknown keys are
// ignored by older versions, so the permissions.deny rules provide the enforced fallback.
export function claudeSandboxSettings(policy: SandboxPolicy): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false, // no escape hatch to run outside the sandbox
      failIfUnavailable: true, // inferred key: refuse to run rather than fall back to unsandboxed
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [...policy.network.allowedHosts] },
      filesystem: {
        allowWrite: [...policy.write.allow],
        denyWrite: [...policy.write.deny],
        denyRead: [...policy.read.deny],
      },
    },
    permissions: {
      deny: [...policy.read.deny.map((p) => `Read(${p})`), ...policy.write.deny.map((p) => `Edit(${p})`)],
    },
  };
}

// argv for spawning through srt: `srt --settings <file> <command> [args...]` (inferred from the
// sandbox-runtime README; the settings file is the Claude settings written by the caller).
export function srtArgs(_policy: SandboxPolicy, settingsPath: string, command: string, args: string[]): string[] {
  return ['srt', '--settings', settingsPath, command, ...args];
}

// Push and publish credentials stay with the orchestrator. Model credentials stay with the worker.
const SECRET_NAMES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'CARGO_REGISTRY_TOKEN',
]);
const SECRET_PATTERNS = [/^NPM_CONFIG__AUTH/i, /^TWINE_/, /^PYPI_/, /^CARGO_REGISTRIES_.*TOKEN$/];

export function scrubWorkerEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    const keep = k === 'ANTHROPIC_API_KEY' || k.startsWith('CLAUDE_');
    if (!keep && (SECRET_NAMES.has(k) || SECRET_PATTERNS.some((re) => re.test(k)))) continue;
    out[k] = v;
  }
  return out;
}
