// Frozen promotion scorer. It lives in the top-level scorer/ directory, outside the evolvable
// harness, so the evolver can neither edit it nor see it. Eval replays are scored here, and
// the candidate's own judge never decides promotion.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson, type Runner } from './agent.ts';
import { PACKAGE_ROOT } from './harness.ts';
import { isGradingSurface } from './integrity.ts';
import { resolveModel } from './models.ts';

export const SCORER_DIR = join(PACKAGE_ROOT, 'scorer');
export const SCORER_MARKER = 'FROZEN SCORER REPLAY';
const MAX_DIFF_CHARS = 20_000;

export interface Scorer {
  version: string;
  model: string;
  budgetUsd: number;
  judge: string;
  checklist: string;
}

export interface ScorerVerdict {
  pass: boolean;
  score: number;
  summary: string;
}

export interface ScoredReplay {
  ok: boolean; // false when the scorer call itself failed
  score: number; // 0 unless the check passed and the scorer verdict passed
  verdict?: ScorerVerdict;
  cost: number;
  error?: string;
}

export interface ReplayEvidence {
  goal: string;
  diff: string;
  checkPassed: boolean | null; // null when the case has no check
  integrityFlags?: string[]; // integrity-monitor findings for the replay, shown to the scorer as evidence
  cwd: string;
  runId?: string;
}

export function loadScorer(dir = SCORER_DIR): Scorer {
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { version?: string; model?: string; budgetUsd?: number };
  if (!cfg.model || !cfg.version) throw new Error(`scorer config at ${dir} must pin model and version`);
  const text = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return { version: String(cfg.version), model: resolveModel(cfg.model), budgetUsd: cfg.budgetUsd ?? 1, judge: text('judge.md'), checklist: text('checklist.md') };
}

const SCHEMA = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, score: { type: 'number' }, summary: { type: 'string' } },
  required: ['pass', 'score', 'summary'],
};

// Fit a diff into the scorer's budget without letting size hide tampering: files are split out, grading
// surfaces (tests, scenarios, workflows) go first, each file gets an equal share, and anything cut is named.
export function fitDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  const chunks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const nameOf = (c: string) => /^diff --git a\/(.+?) b\//.exec(c)?.[1] ?? '';
  const ordered = [...chunks.filter((c) => isGradingSurface(nameOf(c))), ...chunks.filter((c) => !isGradingSurface(nameOf(c)))];
  const cap = Math.max(1000, Math.floor(max / ordered.length));
  const kept: string[] = [];
  const cut: string[] = [];
  let used = 0;
  for (const c of ordered) {
    const body = c.length > cap ? `${c.slice(0, cap)}\n... (file diff truncated)\n` : c;
    if (used + body.length > max) cut.push(nameOf(c) || '(unnamed)');
    else {
      kept.push(body);
      used += body.length;
      if (c.length > cap) cut.push(`${nameOf(c)} (partial)`);
    }
  }
  return `${kept.join('')}\n... (diff truncated; cut or partial: ${cut.join(', ') || 'none'})`;
}

// The replay's own satisfaction is deliberately absent from the prompt.
export function scorerPrompt(s: Scorer, e: ReplayEvidence): string {
  const check = e.checkPassed === null ? 'no check configured' : e.checkPassed ? 'PASSED' : 'FAILED';
  const flags = e.integrityFlags?.length ? `INTEGRITY MONITOR FLAGS (grading-surface edits, weakened tests, reward hacks):\n${e.integrityFlags.map((f) => `- ${f}`).join('\n')}` : '';
  return [`${SCORER_MARKER} (scorer v${s.version})`, `SCORER CHECKLIST:\n${s.checklist}`, `GOAL:\n${e.goal}`, `CHECK RESULT: ${check}`, flags, `DIFF:\n${fitDiff(e.diff) || '(empty)'}`].filter(Boolean).join('\n\n');
}

export async function scoreReplay(scorer: Scorer, runner: Runner, e: ReplayEvidence): Promise<ScoredReplay> {
  if (e.checkPassed === false) return { ok: true, score: 0, cost: 0 };
  const res = await runner({ role: 'judge', prompt: scorerPrompt(scorer, e), system: scorer.judge, cwd: e.cwd, model: scorer.model, budgetUsd: scorer.budgetUsd, schema: SCHEMA, tools: ['Read', 'Grep', 'Glob'], meta: e.runId ? { run: e.runId } : undefined });
  if (!res.ok) return { ok: false, score: 0, cost: res.costUsd, error: res.error ?? 'scorer failed' };
  const raw = extractJson(res) as Partial<ScorerVerdict> | undefined;
  if (!raw || typeof raw.pass !== 'boolean' || typeof raw.score !== 'number') return { ok: false, score: 0, cost: res.costUsd, error: 'scorer returned no verdict' };
  const verdict = { pass: raw.pass, score: Math.min(1, Math.max(0, raw.score)), summary: String(raw.summary ?? '') };
  return { ok: true, score: verdict.pass ? verdict.score : 0, verdict, cost: res.costUsd };
}
