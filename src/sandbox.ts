// Pure sandbox helpers: detection, policy, settings mapping, env scrubbing. No IO at import time;
// every external probe is injected so tests run on machines without bwrap, socat, srt or sandbox-exec.
//
// Boundary model: the OS sandbox is the real control. src/guard.ts is a deny-list hook and stays as a
// backstop (defence in depth), because a python/node/git-remote command can bypass its regexes.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DEFAULT_NETWORK } from './container.ts';
// agent.ts imports this module too. The cycle is safe because neither side uses the other at import time:
// pre-flight calls these only inside preflightSandbox, so it builds probes through the worker code path.
import { buildArgs, buildCommand, wrapCommand, type AgentRequest, type AgentSandbox } from './agent.ts';

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
  network: { allowedHosts: string[]; allowLocalBinding: boolean };
  gitCommonDir: string; // shared by every worktree; the docker backend mounts it and workers commit into it
}

export interface PolicyInput {
  worktree: string;
  tmpDir: string;
  home: string;
  hiddenScenarioDir: string; // the judge-only scenario directory under .orchestra, supplied by the caller
  gitCommonDir: string;
  allowedHosts?: string[];
  // Opt-in. Tests that bind 127.0.0.1 fail inside the sandbox without it. Risk: on macOS it also lets
  // sandboxed commands connect to any localhost port (local databases, dev servers) without the proxy.
  allowLocalBinding?: boolean;
}

// Credential locations and secret files a worker never needs. ".env*" is a glob, matched anywhere.
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.npmrc', '.netrc'];
const ENV_GLOBS = ['**/.env', '**/.env.*'];

export function buildSandboxPolicy(i: PolicyInput): SandboxPolicy {
  const hosts = [MODEL_API_HOST, ...(i.allowedHosts ?? [])];
  return {
    write: {
      // `git commit` in a worktree writes objects, refs/heads and worktrees/<id> under the common git
      // dir, so it must be writable (the docker backend mounts it rw for the same reason).
      allow: [i.worktree, i.tmpDir, i.gitCommonDir],
      // Hooks and config inside it are code-execution vectors for the orchestrator, so workers get
      // read-only access. The deny is nested in the allow and takes precedence.
      deny: [join(i.gitCommonDir, 'hooks'), join(i.gitCommonDir, 'config')],
    },
    read: { deny: [...HOME_SECRETS.map((p) => join(i.home, p)), ...ENV_GLOBS, i.hiddenScenarioDir] },
    network: { allowedHosts: [...new Set(hosts)], allowLocalBinding: i.allowLocalBinding === true },
    gitCommonDir: i.gitCommonDir,
  };
}

// Claude Code settings. Keys checked against the Claude Code sandboxing and settings docs
// (2026-10-26): sandbox.enabled, sandbox.failIfUnavailable (refuse to start when the sandbox
// cannot initialise), sandbox.allowUnsandboxedCommands, sandbox.network.allowedDomains and
// sandbox.filesystem.{allowWrite,denyWrite,denyRead}. Sandbox filesystem paths use plain
// conventions ("/tmp/x" is absolute). The permissions.deny Read(...)/Edit(...) rules are a second
// layer for the built-in file tools, which the OS sandbox does not cover. They are also the fallback
// on an older Claude Code that ignores sandbox keys it does not know; the pre-flight probe is what
// catches a sandbox that silently did not engage.
// Permission rules use a different syntax (permissions docs): a single leading "/" is relative to
// the project root and an absolute path needs "//". A directory needs "/**" to cover its contents,
// so absolute entries emit both the bare path (a file, or the directory itself) and the "/**"
// form. Globs and relative entries (for example "**/.env") pass through unchanged.
export function permissionRules(tool: 'Read' | 'Edit', paths: string[]): string[] {
  return paths.flatMap((p) => {
    if (!p.startsWith('/')) return [`${tool}(${p})`];
    const abs = `/${p}`;
    return [`${tool}(${abs})`, `${tool}(${abs.replace(/\/+$/, '')}/**)`];
  });
}

export function claudeSandboxSettings(policy: SandboxPolicy): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false, // no escape hatch to run outside the sandbox
      failIfUnavailable: true, // refuse to run rather than fall back to unsandboxed
      autoAllowBashIfSandboxed: true,
      // allowLocalBinding is emitted only when enabled, so the default shape is unchanged.
      network: { allowedDomains: [...policy.network.allowedHosts], ...(policy.network.allowLocalBinding ? { allowLocalBinding: true } : {}) },
      filesystem: {
        allowWrite: [...policy.write.allow],
        denyWrite: [...policy.write.deny],
        denyRead: [...policy.read.deny],
      },
    },
    permissions: {
      deny: [...permissionRules('Read', policy.read.deny), ...permissionRules('Edit', policy.write.deny)],
    },
  };
}

// srt (sandbox-runtime) settings file, a different shape from Claude Code's: top-level `network`
// and `filesystem` keys, paths as plain strings (no Read()/Edit() rule syntax). Checked against the
// @anthropic-ai/sandbox-runtime 0.0.81 README (2026-10-26): network.{allowedDomains,deniedDomains}
// and filesystem.{denyRead,allowWrite,denyWrite}. allowWrite/denyWrite take literal paths. denyRead
// globs (**/.env) differ by platform: macOS matches them as patterns, while Linux (bwrap) expands
// them to the files that exist when the command starts, so a .env created later in the run stays
// readable there. The guard hook covers the built-in file tools, not a shell `cat`, so on Linux
// that gap is open for files created mid-run.
export function srtSandboxSettings(policy: SandboxPolicy): Record<string, unknown> {
  return {
    network: {
      allowedDomains: [...policy.network.allowedHosts],
      deniedDomains: [],
      ...(policy.network.allowLocalBinding ? { allowLocalBinding: true } : {}),
    },
    filesystem: {
      denyRead: [...policy.read.deny],
      allowWrite: [...policy.write.allow],
      denyWrite: [...policy.write.deny],
    },
  };
}

// argv for spawning through srt: `srt --settings <file> -- <command> [args...]`. srt parses its own
// options anywhere in argv, so without "--" it takes the wrapped claude's `--settings <json>` as its
// own settings path (the last one wins) and refuses to start. The settings file must be the srt
// shape from srtSandboxSettings.
export function srtArgs(_policy: SandboxPolicy, settingsPath: string, command: string, args: string[]): string[] {
  return ['srt', '--settings', settingsPath, '--', command, ...args];
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

// Env for orchestrator-run commands that execute worker-written code (oracle tests and probes, scenario
// checks, mutation runs). Those processes are not model sessions, so on top of the push and publish
// credentials scrubWorkerEnv removes they get no model credentials either. PATH, HOME and the rest stay.
export function scrubVerifierEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = scrubWorkerEnv(env);
  for (const k of Object.keys(out)) if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')) delete out[k];
  return out;
}

// ---------- pre-flight self-test (W5.2) ----------

export interface ProbeExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string; // set when the wrapper could not be started at all
}
export type ProbeExec = (command: string, args: string[], opts: { cwd: string; timeoutMs: number }) => ProbeExecResult;

export interface PreflightOptions {
  cwd: string; // a worktree the worker could use
  docker?: { image?: string; gvisor?: boolean; network?: string };
  timeoutMs?: number;
  model?: string; // claude backend: model for the probe session (default sonnet); the run passes its worker model
  // Candidate host dirs for the docker read canary, tried in order (default: see unmountedCanaryBase).
  // Injectable because inside a sandbox neither default is writable, so tests need a controllable base.
  canaryBases?: string[];
}

export interface PreflightResult {
  ok: boolean;
  failures: string[]; // each names the probe: "network probe ..." or "read probe ..."
  warnings: string[]; // probes that could not be run meaningfully; the run continues but should say so
  costUsd: number; // model spend of the probes (claude backend only: its probes are real sessions), 0 otherwise
}

// Spend of one claude -p stream-json session from its stdout. total_cost_usd is cumulative across result
// messages (see the runner in src/agent.ts), so the largest one is the session total. Non-JSON lines are skipped.
export function probeSessionCost(stdout: string): number {
  let cost = 0;
  for (const line of stdout.split('\n')) {
    if (!line.includes('"result"')) continue;
    try {
      const msg = JSON.parse(line);
      if (msg?.type === 'result' && Number.isFinite(Number(msg.total_cost_usd))) cost = Math.max(cost, Number(msg.total_cost_usd));
    } catch {
      // not a JSON line (stderr noise, partial write): nothing to count
    }
  }
  return cost;
}

const OPEN = 'ORCHESTRA_PROBE_OPEN';
const BLOCKED = 'ORCHESTRA_PROBE_BLOCKED';
const ARGV_MISMATCH = 'ORCHESTRA_PROBE_ARGV_MISMATCH';
const VISIBLE = 'ORCHESTRA_PROBE_VISIBLE';
// Markers are split inside the script so a model that echoes the command cannot produce a false match.
const marker = (m: string): string => `${JSON.stringify(m.slice(0, 16))}+${JSON.stringify(m.slice(16))}`;
// Not on the allow-list unless the user listed it, in which case the fallback host is used.
const PROBE_HOSTS = ['example.com', 'example.org'];

// The network probe is a deliberate outbound attempt to a host that is NOT on the allow-list. It is
// expected to be blocked; if it connects, the sandbox is not confining the worker and the run aborts.
function networkScript(host: string): string {
  return `fetch(${JSON.stringify(`https://${host}/`)},{signal:AbortSignal.timeout(4000)}).then(()=>console.log(${marker(OPEN)}),()=>console.log(${marker(BLOCKED)}))`;
}

// Positive control for docker: the worktree must be visible inside the container, holding what the host wrote.
// Every other probe passes when access is blocked, so a mount that came up empty would pass them all: docker
// creates a missing bind-mount source as an empty directory, which is what colima and Docker Desktop do for
// a host path outside the directories they share with their VM (colima shares only $HOME by default).
function visibleScript(file: string, nonce: string): string {
  return `try{const s=require('fs').readFileSync(${JSON.stringify(file)},'utf8');console.log(s===${JSON.stringify(nonce)}?${marker(VISIBLE)}:${marker(BLOCKED)})}catch(e){console.log(${marker(BLOCKED)})}`;
}

function readScript(file: string): string {
  return `try{require('fs').readFileSync(${JSON.stringify(file)});console.log(${marker(OPEN)})}catch(e){console.log(${marker(BLOCKED)})}`;
}

// Trailing arguments shaped like the ones real workers pass after the command: a --settings flag whose
// JSON value holds double quotes, spaces and a dollar sign, plus -p and a prompt-like value. The claude
// probe's Bash command carries them after `node -e <script> PROBE_ARGV_POSITIONAL`, and the probe script
// checks it received them intact. They stay short because the model has to retype the command.
export const PROBE_TRAILING_ARGS: readonly string[] = Object.freeze(['--settings', '{"a": "x y $HOME", "b": "it\'s"}', '-p', 'Say "hi" to $USER']);

// Why a positional and not `--`: node rejects `node -e <script> --settings ...` ("bad option"), so
// something has to end node's option parsing. A literal `--` would also end srt's option parsing, so a
// srtArgs that lost its own `--` (the #74 bug) would still stop at the probe's `--` and never see the
// trailing --settings, and pre-flight would pass. A plain positional ends node's parsing (node treats
// everything after the first non-option as script args) but not srt's (commander keeps parsing known
// options after operands), so the outer argv carries `--settings <json>` with no terminator before it,
// exactly like a worker's `claude ... --settings <json>`. It also needs no shell in the docker image.
export const PROBE_ARGV_POSITIONAL = 'orchestra-probe';

// The stand-in worker request the probes are built from. Its prompt and system prompt carry the
// characters a wrapper is most likely to mangle: double and single quotes, spaces and a dollar sign.
export const PROBE_PROMPT = 'Say "hi" to $USER';
const PROBE_SYSTEM = "Pre-flight probe: it's not a task.";
const PROBE_BUDGET_USD = 0.5;

export function probeRequest(prompt: string, cwd: string, sandbox: AgentSandbox, model = 'sonnet'): AgentRequest {
  return { role: 'worker', prompt, system: PROBE_SYSTEM, cwd, model, budgetUsd: PROBE_BUDGET_USD, maxTurns: 4, allowedTools: ['Bash'], sandbox };
}

// The srt and docker probes' trailing args: what buildArgs gives a worker on this sandbox, so pre-flight
// checks the real worker argv (inline guard --settings JSON, -p, --append-system-prompt and the rest).
export function probeWorkerArgs(cwd: string, sandbox: AgentSandbox, model?: string): string[] {
  return buildArgs(probeRequest(PROBE_PROMPT, cwd, sandbox, model));
}

// With `node -e <script> orchestra-probe a b`, process.argv is [node, orchestra-probe, a, b]. The check
// is exact: same length, strict equality, so a dropped, split or re-quoted argument is a mismatch.
function argvGuard(body: string, trailing: readonly string[]): string {
  const expected = JSON.stringify([PROBE_ARGV_POSITIONAL, ...trailing]);
  return `const a=process.argv.slice(1),e=${expected};if(a.length!==e.length||e.some((x,i)=>a[i]!==x)){console.log(${marker(ARGV_MISMATCH)})}else{${body}}`;
}

// A host directory for the docker read canary that no container mount covers. Read isolation for
// docker comes from not mounting a path, so the canary has to live outside every mount (tmpdir is
// mounted rw, so the usual temp location would make the probe open for real). Null when none is usable.
function unmountedCanaryBase(mounts: string[], bases: string[] = ['/var/tmp', homedir()]): string | null {
  const covered = (p: string) => mounts.some((m) => p === m || p.startsWith(m.endsWith(sep) ? m : m + sep));
  for (const base of bases) {
    try {
      if (base && !covered(base)) {
        const d = mkdtempSync(join(base, 'orchestra-canary-'));
        return d;
      }
    } catch {
      // not writable here, try the next candidate
    }
  }
  return null;
}

// Runs both probes inside the same wrapper workers get. Each must FAIL (be blocked) for ok. A probe
// that succeeds, a wrapper that cannot start, or output with no marker (inconclusive) all fail closed.
// Probes are built through the worker code path (wrapCommand and buildCommand in src/agent.ts), so a bug
// in how workers assemble their own argv shows up here too. srt and docker: the wrapped inner command is
// `node -e <script> orchestra-probe <worker args>`, where the worker args come from buildArgs (no `--`
// in front of them, see PROBE_ARGV_POSITIONAL), and the script verifies it received them byte for byte.
// This catches the class of bug fixed in PR #74, where srt consumed the worker's own --settings as its
// settings path. claude: the probe is a real worker-shaped `claude -p` session from buildCommand, so the
// sandbox block is the one inline in the worker's --settings, and its Bash command carries
// PROBE_TRAILING_ARGS so the Bash tool's sandbox wrapper is checked for argv pass-through too.
// A mismatch fails pre-flight.
export function preflightSandbox(policy: SandboxPolicy, backend: 'srt' | 'claude' | 'docker', exec: ProbeExec, opts: PreflightOptions): PreflightResult {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-preflight-'));
  const failures: string[] = [];
  const warnings: string[] = [];
  let costUsd = 0;
  let canaryDir: string | null = null;
  try {
    // srt and claude can deny reads, so the canary sits in tmp and its dir is added to the deny list.
    // docker cannot: its canary must be outside every mounted path (see unmountedCanaryBase).
    let canary: string | null = join(dir, 'canary.txt');
    if (backend === 'docker') {
      canaryDir = unmountedCanaryBase([opts.cwd, policy.write.allow[1] ?? tmpdir(), policy.gitCommonDir], opts.canaryBases);
      canary = canaryDir ? join(canaryDir, 'canary.txt') : null;
    }
    if (canary) writeFileSync(canary, 'orchestra preflight canary\n');
    const probePolicy: SandboxPolicy = { ...policy, read: { deny: backend === 'docker' ? [...policy.read.deny] : [...policy.read.deny, dir] } };
    // The srt settings file lands in the probe's temp dir, which is removed at the end.
    const sandbox: AgentSandbox = { policy: probePolicy, backend, settingsDir: dir, ...(backend === 'docker' ? { docker: opts.docker } : {}) };
    const host = PROBE_HOSTS.find((h) => !policy.network.allowedHosts.includes(h)) ?? PROBE_HOSTS[0];

    const wrap = (script: string): { command: string; args: string[] } => {
      if (backend === 'claude') {
        // Claude Code's sandbox confines its Bash tool, so the probe goes through a Bash call.
        const cmd = `node -e ${shellQuote(argvGuard(script, PROBE_TRAILING_ARGS))} ${PROBE_ARGV_POSITIONAL} ${PROBE_TRAILING_ARGS.map(shellQuote).join(' ')}`;
        const prompt = `Run exactly this one shell command with the Bash tool and reply with its stdout only, nothing else:\n${cmd}`;
        return buildCommand(probeRequest(prompt, opts.cwd, sandbox, opts.model));
      }
      const trailing = probeWorkerArgs(opts.cwd, sandbox, opts.model);
      return wrapCommand(sandbox, opts.cwd, undefined, ['node', '-e', argvGuard(script, trailing), PROBE_ARGV_POSITIONAL, ...trailing]);
    };

    let probesRun = 0;
    const probe = (name: string, script: string) => {
      probesRun++;
      const { command, args } = wrap(script);
      let r: ProbeExecResult;
      try {
        r = exec(command, args, { cwd: opts.cwd, timeoutMs });
      } catch (e) {
        failures.push(`${name} probe: sandbox wrapper could not start (${(e as Error).message})`);
        return;
      }
      if (backend === 'claude') costUsd += probeSessionCost(r.stdout);
      if (r.error) return void failures.push(`${name} probe: sandbox wrapper could not start (${r.error})`);
      const out = `${r.stdout}\n${r.stderr}`;
      // For docker the image's ENTRYPOINT sits between the wrapper and node and can rewrite argv too,
      // so the message names it rather than blaming docker alone.
      const culprit = backend === 'docker' ? 'the docker wrapper or the image entrypoint' : backend === 'claude' ? "Claude Code's Bash sandbox wrapper, or the model retyping the command" : `the ${backend} wrapper`;
      if (out.includes(ARGV_MISMATCH)) failures.push(`${name} probe: worker argv was not passed through the sandbox wrapper intact (${culprit} altered or dropped arguments)`);
      else if (out.includes(OPEN)) failures.push(`${name} probe succeeded inside the sandbox (expected it to be blocked)`);
      else if (!out.includes(BLOCKED)) failures.push(`${name} probe inconclusive: wrapper exited ${r.status} with no result, treating the sandbox as not working`);
    };

    // allowLocalBinding is opt-in and widens the sandbox, so the run log says so every time. The docker
    // backend never reads it (container networking is set by --sandbox-network), so a user who set it
    // there would otherwise assume local binding works or is confined when neither is guaranteed.
    if (policy.network.allowLocalBinding) {
      warnings.push(
        backend === 'docker'
          ? 'sandbox.allowLocalBinding is ignored with --sandbox docker: container networking comes from --sandbox-network'
          : 'sandbox.allowLocalBinding is on: localhost access is widened, and on macOS sandboxed commands can connect to any localhost port (local databases, dev servers), bypassing the proxy',
      );
    }
    const dockerNet = backend === 'docker' ? (opts.docker?.network ?? DEFAULT_NETWORK) : null;
    if (dockerNet === 'none') {
      warnings.push(`docker network is none: the worker cannot reach ${MODEL_API_HOST}, so a claude worker will fail unless the image provides its own route. Set --sandbox-network to a network that reaches the model API (docs/isolation.md)`);
    } else if (dockerNet) {
      // The "must be blocked" probe would be open by design on a network the user chose.
      warnings.push(`docker network is "${dockerNet}": docker does not enforce the host allow-list, so the network probe is skipped and outbound access is whatever that network allows`);
    }
    if (dockerNet === null || dockerNet === 'none') {
      // Positive control: the same fetch, unsandboxed. A blocked result inside the sandbox only means
      // something if the host can reach the probe target at all.
      const netScript = networkScript(host);
      let control = '';
      try {
        const r = exec('node', ['-e', netScript], { cwd: opts.cwd, timeoutMs });
        control = r.error ? '' : `${r.stdout}\n${r.stderr}`;
      } catch {
        control = '';
      }
      if (control.includes(OPEN)) probe('network', netScript);
      else warnings.push(`network probe inconclusive: the unsandboxed control to ${host} also failed (no connectivity from this host), so the sandbox's network block is NOT verified`);
    }
    if (backend === 'docker') {
      // It runs through the same wrapper and argv check as the other probes, so it counts toward probesRun: with
      // docker the argv shape is now always exercised, even when the network and read probes are both skipped.
      const nonce = randomBytes(8).toString('hex');
      const file = join(opts.cwd, `.orchestra-preflight-${nonce}`);
      let wrote = false;
      try {
        writeFileSync(file, nonce);
        wrote = true;
      } catch (e) {
        failures.push(`worktree probe: could not write a marker into the worktree ${opts.cwd} (${(e as Error).message.split('\n')[0]})`);
      }
      if (wrote) try {
        const { command, args } = wrap(visibleScript(file, nonce));
        probesRun++;
        let r: ProbeExecResult | undefined;
        try {
          r = exec(command, args, { cwd: opts.cwd, timeoutMs });
        } catch (e) {
          failures.push(`worktree probe: sandbox wrapper could not start (${(e as Error).message})`);
        }
        if (r && r.error) failures.push(`worktree probe: sandbox wrapper could not start (${r.error})`);
        else if (r && `${r.stdout}\n${r.stderr}`.includes(ARGV_MISMATCH)) failures.push('worktree probe: worker argv was not passed through the sandbox wrapper intact (the docker wrapper or the image entrypoint altered or dropped arguments)');
        else if (r && !`${r.stdout}\n${r.stderr}`.includes(VISIBLE)) {
          failures.push(`worktree probe: the worktree ${opts.cwd} is not visible inside the container, so workers would see an empty directory. With colima or Docker Desktop, share this path with the VM (colima shares only $HOME by default; see docs/isolation.md)`);
        }
      } finally {
        rmSync(file, { force: true });
      }
    }
    if (canary) probe('read', readScript(canary));
    else warnings.push('read probe skipped: no host directory outside the docker mounts is writable; docker read isolation rests on not mounting secrets');
    // The argv check rides on the probes. srt and claude always run the read probe and docker always runs the
    // worktree probe, so this only fires when a probe could not be set up. Kept so a clean pre-flight never
    // implies a check that did not run.
    if (probesRun === 0) {
      warnings.push(`argv pass-through was NOT verified: both probes were skipped, so pre-flight never ran a command with worker-like arguments through the ${backend} wrapper`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (canaryDir) rmSync(canaryDir, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures, warnings, costUsd: Math.round(costUsd * 10_000) / 10_000 };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
