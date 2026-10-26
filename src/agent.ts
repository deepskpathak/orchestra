// Agent runner: one call = one fresh Claude Code session (`claude -p`), streamed as JSON.
// Fresh context per unit of work is deliberate (Ralph loop / Anthropic harness pattern):
// all state lives in git and .orchestra, never in a long conversation.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from './harness.ts';
import { countToolUse } from './exploration.ts';
import { containerEnvNames, dockerArgs, hostUser, DEFAULT_IMAGE } from './container.ts';
import { claudeSandboxSettings, srtArgs, srtSandboxSettings, type SandboxPolicy } from './sandbox.ts';
import type { Role, WorkerOutcome } from './types.ts';

// Opt-in OS sandbox for one agent call. 'srt' wraps the claude command and reads a settings file we
// write outside the worker-writable tree (settingsDir); 'claude' passes the sandbox block inline in
// --settings. Nothing is written into the worktree, so the worker cannot persist settings across
// calls and a judge session in the same worktree does not auto-load the worker sandbox.
export interface AgentSandbox {
  policy: SandboxPolicy;
  backend: 'srt' | 'claude' | 'docker';
  docker?: { image?: string; gvisor?: boolean; network?: string }; // docker backend only
  settingsDir?: string; // srt only: a directory the worker cannot write to; defaults to a fresh temp dir
}

export interface AgentRequest {
  role: Role;
  prompt: string;
  system: string;
  cwd: string;
  model: string;
  budgetUsd: number;
  maxTurns?: number; // hard turn cap for the session (W6.5); absent: no --max-turns flag
  schema?: object;
  tools?: string[]; // restrict the built-in tool set (read-only roles)
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  logFile?: string;
  timeoutMs?: number;
  meta?: { task?: string; attempt?: number; run?: string; variant?: 'a' | 'b' | `s${number}` }; // a/b: contrastive pair, sN: best-of-n sample
  onAction?: (action: string) => void;
  sandbox?: AgentSandbox; // absent: spawn exactly as before
  env?: Record<string, string | undefined>; // absent: process.env
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Pulls token counts from a stream-json `result` message. Missing or non-numeric fields count as 0;
// undefined when the message carries no usage object at all.
export function parseUsage(msg: any): Usage | undefined {
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
  };
}

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
  durationMs: number;
  error?: string;
  usage?: Usage;
  toolCounts?: Record<string, number>; // tool_use blocks by tool name
}

export type Runner = (req: AgentRequest) => Promise<AgentResult>;

// Guard hook injected into every agent session. Blocks holdout access, network, pushes.
// For the claude backend the sandbox block rides in the same inline --settings JSON, built fresh from
// the policy on every call (nothing is read back from the worktree).
function guardSettings(sandbox?: AgentSandbox): string {
  const cmd = `node "${join(PACKAGE_ROOT, 'bin', 'orchestra.ts')}" guard`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }],
    },
    ...(sandbox?.backend === 'claude' ? claudeSandboxSettings(sandbox.policy) : {}),
  });
}

export function buildArgs(req: AgentRequest): string[] {
  const args = [
    '-p',
    req.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    req.model,
    '--append-system-prompt',
    req.system,
    '--max-budget-usd',
    String(req.budgetUsd),
    '--no-session-persistence',
    // Isolation: skip the user's personal plugins and hooks; only the repo's project settings apply.
    '--setting-sources',
    'project,local',
    '--settings',
    guardSettings(req.sandbox),
    // Nobody is watching a worker; anything that would prompt is denied instead of hanging.
    '--permission-prompts',
    'none',
    '--permission-mode',
    req.permissionMode ?? 'acceptEdits',
  ];
  if (req.maxTurns !== undefined) args.push('--max-turns', String(req.maxTurns));
  if (req.tools) args.push('--tools', req.tools.join(','));
  if (req.allowedTools?.length) args.push('--allowedTools', req.allowedTools.join(','));
  if (req.disallowedTools?.length) args.push('--disallowedTools', req.disallowedTools.join(','));
  if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
  return args;
}

// Fresh srt settings file from the policy, outside the worktree. Never merged with existing content.
export function writeSrtSettings(cwd: string, policy: SandboxPolicy, settingsDir?: string): string {
  const dir = settingsDir ?? mkdtempSync(join(tmpdir(), 'orchestra-srt-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `srt-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}.json`);
  writeFileSync(file, JSON.stringify(srtSandboxSettings(policy), null, 2) + '\n');
  return file;
}

export type SpawnFn = typeof spawn;

// The command and args to spawn for a request. Without a sandbox this is plain `claude`.
export function buildCommand(req: AgentRequest): { command: string; args: string[] } {
  const args = buildArgs(req);
  if (req.sandbox?.backend === 'docker') {
    const { policy, docker } = req.sandbox;
    const [command, ...rest] = dockerArgs({
      worktree: req.cwd,
      tmpDir: policy.write.allow[1],
      image: docker?.image ?? DEFAULT_IMAGE,
      envNames: containerEnvNames(req.env ?? {}),
      gitCommonDir: policy.gitCommonDir,
      gvisor: docker?.gvisor,
      network: docker?.network,
      user: hostUser(),
    });
    return { command, args: [...rest, 'claude', ...args] };
  }
  if (req.sandbox?.backend === 'srt') {
    const settings = writeSrtSettings(req.cwd, req.sandbox.policy, req.sandbox.settingsDir);
    const [command, ...rest] = srtArgs(req.sandbox.policy, settings, 'claude', args);
    return { command, args: rest };
  }
  return { command: 'claude', args };
}

export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const pick = (i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.description ?? '') as string;
  const short = String(pick).replace(/\s+/g, ' ').trim();
  return short ? `${name} ${short}` : name;
}

export const makeClaudeRunner = (spawnFn: SpawnFn = spawn): Runner => (req) =>
  new Promise((resolve) => {
    const started = Date.now();
    const { command, args } = buildCommand(req);
    const child = spawnFn(command, args, { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: req.env ?? process.env });
    if (req.logFile) mkdirSync(dirname(req.logFile), { recursive: true });
    let buf = '';
    let stderr = '';
    let lastText = '';
    let result: AgentResult | null = null;
    const toolCounts: Record<string, number> = {};

    let timedOut = false;
    const timer = req.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, req.timeoutMs)
      : null;

    const handle = (line: string) => {
      if (!line.trim()) return;
      if (req.logFile) appendFileSync(req.logFile, line + '\n');
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      countToolUse(msg, toolCounts);
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') req.onAction?.(summarizeTool(block.name, block.input));
          if (block.type === 'text' && block.text) {
            lastText = block.text;
            req.onAction?.(`says: ${block.text.split('\n')[0]}`);
          }
        }
      } else if (msg.type === 'result') {
        // A worker that starts a background Bash task resumes on the task notification, so one session
        // emits several result messages. num_turns and usage are per segment (sum them); total_cost_usd is
        // cumulative (take the last, summing would double count). Duration is wall clock, set at close.
        // Evidence, not inference: a real two-segment worker session on Claude Code 2.1.310 reported
        //   result 1: num_turns 11, duration_ms 176517, total_cost_usd 0.2656, output_tokens 6690, cache_read 438038
        //   result 2: num_turns 2,  duration_ms 6439,   total_cost_usd 0.2992, output_tokens 674,  cache_read 111157
        // Cost rose while turns, duration and both token counts shown dropped. A cumulative counter cannot
        // decrease, so those are per segment and cost is cumulative. Recheck if a Claude Code upgrade
        // changes the stream-json result shape.
        const isError = Boolean(msg.is_error) || msg.subtype !== 'success';
        const seg = parseUsage(msg);
        const usage = result?.usage && seg
          ? {
              inputTokens: result.usage.inputTokens + seg.inputTokens,
              outputTokens: result.usage.outputTokens + seg.outputTokens,
              cacheReadTokens: result.usage.cacheReadTokens + seg.cacheReadTokens,
              cacheWriteTokens: result.usage.cacheWriteTokens + seg.cacheWriteTokens,
            }
          : (seg ?? result?.usage);
        const turns = (result?.turns ?? 0) + Number(msg.num_turns ?? 0);
        result = {
          ok: !isError,
          text: typeof msg.result === 'string' ? msg.result : lastText,
          // A resumed segment often ends without structured output; the earlier segment's (for example a
          // flag_for_human verdict) is still the session's answer, so it is not dropped.
          structured: msg.structured_output ?? result?.structured,
          // A segment without total_cost_usd keeps the earlier cumulative figure rather than resetting spend to 0.
          costUsd: Number(msg.total_cost_usd ?? result?.costUsd ?? 0),
          turns,
          durationMs: Date.now() - started,
          usage,
          toolCounts,
          error: isError ? (msg.errors?.join('; ') || msg.result || msg.subtype) : undefined,
        };
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, text: '', costUsd: 0, turns: 0, durationMs: Date.now() - started, error: `spawn ${command} failed: ${err.message}` });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      if (buf) handle(buf);
      if (result) {
        const final = { ...result, durationMs: Date.now() - started };
        // A session can emit a success result and then resume (background task notification). If it is
        // then killed (our timeout SIGTERM) or exits non-zero, the earlier success does not describe how
        // the session ended, so report it as failed. Text, cost, turns and usage are kept for the ledger.
        // Exit 0 keeps the result as reported, and an error result keeps its own, more specific error.
        if (final.ok && (signal || (code !== null && code !== 0))) {
          const how = signal ? `killed by ${signal}${timedOut ? ` after the ${req.timeoutMs}ms timeout` : ''}` : `exited ${code}`;
          return resolve({ ...final, ok: false, error: `claude ${how} after a result` });
        }
        return resolve(final);
      }
      resolve({
        ok: false,
        text: lastText,
        costUsd: 0,
        turns: 0,
        durationMs: Date.now() - started,
        error: `claude exited ${code} without a result. ${stderr.trim().slice(0, 500)}`,
      });
    });
  });

export const claudeRunner: Runner = makeClaudeRunner();

// Structured output fallback: if the schema path did not populate, try the last JSON object in text.
export function extractJson(res: AgentResult): unknown {
  if (res.structured !== undefined) return res.structured;
  const m = res.text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

// Worker outcome: structured {outcome:'flag_for_human', reason} or a text line `FLAG_FOR_HUMAN: <reason>`.
export function parseWorkerOutcome(res: AgentResult): WorkerOutcome {
  const s = res.structured as { outcome?: unknown; reason?: unknown } | undefined;
  if (s && typeof s === 'object' && s.outcome === 'flag_for_human') {
    return { outcome: 'flag_for_human', reason: typeof s.reason === 'string' && s.reason.trim() ? s.reason.trim() : 'no reason given' };
  }
  const m = res.text.match(/^\s*FLAG_FOR_HUMAN:[ \t]*(.*)$/m);
  if (m) return { outcome: 'flag_for_human', reason: m[1].trim() || 'no reason given' };
  return { outcome: 'done' };
}

// Quick preflight used by `orchestra doctor`: is the CLI present and authenticated?
export function preflight(): { ok: boolean; detail: string } {
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) return { ok: false, detail: 'claude CLI not found on PATH' };
  const p = spawnSync(
    'claude',
    ['-p', 'Reply with OK', '--output-format', 'json', '--model', 'haiku', '--tools', '', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', '0.05'],
    { encoding: 'utf8', timeout: 90_000 },
  );
  try {
    const r = JSON.parse(p.stdout);
    if (r.is_error) return { ok: false, detail: `claude ${v.stdout.trim()}: ${r.result}` };
    return { ok: true, detail: `claude ${v.stdout.trim()}, headless auth OK` };
  } catch {
    return { ok: false, detail: `claude ${v.stdout.trim()}: unexpected output ${(p.stdout || p.stderr).slice(0, 200)}` };
  }
}
