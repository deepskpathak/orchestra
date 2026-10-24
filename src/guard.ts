// PreToolUse guard injected into every agent session. A deny-list backstop (defence in depth),
// enforced by the harness rather than by prompt: holdout scenarios stay hidden, no publishing,
// no secrets, and obvious network commands are refused. It matches command text and paths, so
// python, node, git remotes or DNS can bypass it. The real boundary is the OS sandbox or
// container (src/sandbox.ts, src/container.ts); see docs/architecture.md.

import { join, resolve, sep } from 'node:path';
import { PACKAGE_ROOT } from './harness.ts';

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

const NETWORK = /\b(curl|wget|ssh|scp|rsync|nc|telnet|ftp)\b|\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr|release|repo)\s+create\b/;
const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);
const SECRET_PATH = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials(\.json)?|.*\.pem|.*\.key)$/;

// The frozen scorer is the installed one (PACKAGE_ROOT/scorer). A scorer/ directory inside the repo
// being worked on is ordinary project code and stays editable (the integrity monitor still flags a
// root-level scorer/ edit in the diff).
export interface GuardContext {
  cwd?: string;
  scorerDir?: string;
}

const SCORER_WRITE_CMD =
  /(^|[\s;&|(])(rm|mv|cp|tee|touch|truncate|chmod|install|ln|dd)\b|\bsed\s+(-\w*i|--in-place)|\bperl\s+-\w*i|\bgit\s+(-\S+\s+\S+\s+)*(checkout|restore|reset|apply|stash|clean|rm|mv|commit|merge|rebase)\b|\b(python3?|node|ruby|perl|deno|bun)\s+(-\w*[ce]|--eval)\b|\b(ba|z)?sh\s+-\w*c\b|>/;
// Redirects that do not write a file: fd duplication (2>&1, >&2) and the null device.
const HARMLESS_REDIRECT = /\d*>&\d*-?|\d*>>?\s*\/dev\/null/g;

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

// True when `token` names the scorer directory or something inside it. Glob tokens count when any
// leading portion of the pattern can match the directory.
function inScorer(token: string, ctx: Required<GuardContext>): boolean {
  if (!token) return false;
  const abs = resolve(ctx.cwd, token);
  const dir = resolve(ctx.scorerDir);
  if (/[*?[]/.test(abs)) {
    const parts = abs.split('/');
    for (let i = 1; i <= parts.length; i++) if (globToRegExp(parts.slice(0, i).join('/') || '/').test(dir)) return true;
    return false;
  }
  return abs === dir || abs.startsWith(dir + sep);
}

// Best effort for Bash: any token (after `cd`, `git -C`, globs and quoting are stripped to words) that
// resolves into the scorer plus a write-capable operation. It cannot see through computed paths, so
// the scorer being pinned outside the harness and the monitor on the diff remain the real defence.
function touchesScorer(toolName: string, input: Record<string, unknown>, ctx: Required<GuardContext>): boolean {
  if (toolName === 'Bash') {
    const cmd = String(input?.command ?? '').replace(/\\/g, '/');
    if (!SCORER_WRITE_CMD.test(cmd.replace(HARMLESS_REDIRECT, ' '))) return false;
    return cmd.split(/[\s;&|()<>`'"=,]+/).some((t) => inScorer(t, ctx));
  }
  return [input?.file_path, input?.path, input?.notebook_path].some((p) => inScorer(String(p ?? '').replace(/\\/g, '/'), ctx));
}

export function decide(toolName: string, input: Record<string, unknown>, ctx: GuardContext = {}): GuardDecision {
  const scorerCtx = { cwd: ctx.cwd ?? process.cwd(), scorerDir: ctx.scorerDir ?? join(PACKAGE_ROOT, 'scorer') };
  const blob = JSON.stringify(input ?? {});
  if (/\.orchestra\/holdout|\.orchestra\\\\holdout/.test(blob)) return { allow: false, reason: 'Holdout scenarios are visible to the judge only.' };
  if (/\.orchestra\/(harness|evals|archive\.json)/.test(blob) && toolName !== 'Read' && toolName !== 'Grep' && toolName !== 'Glob') {
    return { allow: false, reason: 'Agents may not modify the harness, evals, or archive.' };
  }
  if (!READ_ONLY.has(toolName) && touchesScorer(toolName, input, scorerCtx)) {
    return { allow: false, reason: 'Agents may not modify the frozen scorer.' };
  }
  if (toolName === 'Bash') {
    const cmd = String(input?.command ?? '');
    if (NETWORK.test(cmd)) return { allow: false, reason: 'Network access and publishing are disabled inside Orchestra.' };
  }
  const path = String(input?.file_path ?? input?.path ?? '');
  if (path && SECRET_PATH.test(path)) return { allow: false, reason: 'Secret files are off limits.' };
  return { allow: true };
}

export async function guardMain(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    // Malformed hook input: fail closed for safety.
    process.stderr.write('orchestra guard: unreadable hook input');
    process.exit(2);
  }
  const d = decide(payload.tool_name ?? '', payload.tool_input ?? {});
  if (!d.allow) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `orchestra guard: ${d.reason}` } }),
    );
  }
  process.exit(0);
}
