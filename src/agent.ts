// Agent runner: one call = one fresh Claude Code session (`claude -p`), streamed as JSON.
// Fresh context per unit of work is deliberate (Ralph loop / Anthropic harness pattern):
// all state lives in git and .orchestra, never in a long conversation.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from './harness.ts';
import { countToolUse } from './exploration.ts';
import { claudeSandboxSettings, srtArgs, type SandboxPolicy } from './sandbox.ts';
import type { Role, WorkerOutcome } from './types.ts';

// Opt-in OS sandbox for one agent call. 'srt' wraps the claude command; 'claude' relies on Claude Code's
// own sandbox settings. Either way the settings land in the worktree's .claude/settings.local.json.
export interface AgentSandbox {
  policy: SandboxPolicy;
  backend: 'srt' | 'claude';
}

export interface AgentRequest {
  role: Role;
  prompt: string;
  system: string;
  cwd: string;
  model: string;
  budgetUsd: number;
  schema?: object;
  tools?: string[]; // restrict the built-in tool set (read-only roles)
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  logFile?: string;
  timeoutMs?: number;
  meta?: { task?: string; attempt?: number; run?: string; variant?: 'a' | 'b' };
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
function guardSettings(): string {
  const cmd = `node "${join(PACKAGE_ROOT, 'bin', 'orchestra.ts')}" guard`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }],
    },
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
    guardSettings(),
    // Nobody is watching a worker; anything that would prompt is denied instead of hanging.
    '--permission-prompts',
    'none',
    '--permission-mode',
    req.permissionMode ?? 'acceptEdits',
  ];
  if (req.tools) args.push('--tools', req.tools.join(','));
  if (req.allowedTools?.length) args.push('--allowedTools', req.allowedTools.join(','));
  if (req.disallowedTools?.length) args.push('--disallowedTools', req.disallowedTools.join(','));
  if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
  return args;
}

// Merge sandbox settings into <cwd>/.claude/settings.local.json, keeping every existing key.
// Objects merge recursively, arrays are unioned, and our values win for scalars (fail-closed).
export function writeSandboxSettings(cwd: string, policy: SandboxPolicy): string {
  const file = join(cwd, '.claude', 'settings.local.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // Unreadable settings are replaced: the sandbox block must be present.
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(mergeSettings(existing, claudeSandboxSettings(policy)), null, 2) + '\n');
  return file;
}

function mergeSettings(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
  const isObj = (v: unknown) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeSettings(out[k], v) : v;
    return out;
  }
  return b;
}

export type SpawnFn = typeof spawn;

// The command and args to spawn for a request. Without a sandbox this is plain `claude`.
export function buildCommand(req: AgentRequest): { command: string; args: string[] } {
  const args = buildArgs(req);
  if (req.sandbox) {
    const settings = writeSandboxSettings(req.cwd, req.sandbox.policy);
    if (req.sandbox.backend === 'srt') {
      const [command, ...rest] = srtArgs(req.sandbox.policy, settings, 'claude', args);
      return { command, args: rest };
    }
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

    const timer = req.timeoutMs
      ? setTimeout(() => {
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
        const isError = Boolean(msg.is_error) || msg.subtype !== 'success';
        result = {
          ok: !isError,
          text: typeof msg.result === 'string' ? msg.result : lastText,
          structured: msg.structured_output ?? undefined,
          costUsd: Number(msg.total_cost_usd ?? 0),
          turns: Number(msg.num_turns ?? 0),
          durationMs: Number(msg.duration_ms ?? Date.now() - started),
          usage: parseUsage(msg),
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
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (buf) handle(buf);
      if (result) return resolve(result);
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
