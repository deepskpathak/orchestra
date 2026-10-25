// Pure time-split eval sets (W3.1): feedback (seen by the evolver), validation (selection), holdout (newest, confirm only).
import type { EvalCase } from './evolve.ts';

export interface SplitRatios { feedback: number; validation: number; holdout: number }
export interface EvalSplits { feedback: EvalCase[]; validation: EvalCase[]; holdout: EvalCase[] }

export const DEFAULT_RATIOS: SplitRatios = { feedback: 0.3, validation: 0.5, holdout: 0.2 };
export const DEFAULT_SIGNOFF_BELOW = 12;

function byAge(a: EvalCase, b: EvalCase): number {
  const d = (a.createdAt ?? 0) - (b.createdAt ?? 0);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Oldest to feedback, newest to holdout. Deterministic regardless of input order. */
export function splitEvals(cases: EvalCase[], ratios: SplitRatios = DEFAULT_RATIOS): EvalSplits {
  const sorted = [...cases].sort(byAge);
  const n = sorted.length;
  const total = ratios.feedback + ratios.validation + ratios.holdout;
  const share = (x: number) => (total > 0 ? Math.max(0, x) / total : 0);
  let holdout = Math.round(n * share(ratios.holdout));
  if (n >= 3) holdout = Math.max(1, holdout);
  holdout = Math.min(holdout, n);
  let feedback = Math.round(n * share(ratios.feedback));
  feedback = Math.min(feedback, n - holdout);
  // With 3+ cases keep validation non-empty so selection has data.
  if (n >= 3 && n - holdout - feedback < 1) feedback = Math.max(0, n - holdout - 1);
  return {
    feedback: sorted.slice(0, feedback),
    validation: sorted.slice(feedback, n - holdout),
    holdout: sorted.slice(n - holdout),
  };
}

/** Below the threshold the holdout is too small to trust; promotion needs a human. */
export function needsHumanSignoff(totalCases: number, threshold = DEFAULT_SIGNOFF_BELOW): boolean {
  return totalCases < threshold;
}

export type SplitName = 'feedback' | 'validation' | 'holdout';
/** Case id to the split it was first assigned to. Persisted so an assignment never changes afterwards. */
export type SplitAssignment = Record<string, SplitName>;

/**
 * Like splitEvals, but a case that already has an assignment keeps it (above all, yesterday's holdout never moves
 * into feedback as new cases arrive and the time window slides). Only unassigned cases are placed, to fill the quota
 * each split is still short of: the newest to holdout, the oldest to feedback, the rest to validation. With no prior
 * assignment the result equals splitEvals. Also returns the assignment to persist.
 */
export function stickySplit(cases: EvalCase[], ratios: SplitRatios = DEFAULT_RATIOS, prior: SplitAssignment = {}): EvalSplits & { assignment: SplitAssignment } {
  const sorted = [...cases].sort(byAge);
  const n = sorted.length;
  const total = ratios.feedback + ratios.validation + ratios.holdout;
  const share = (x: number) => (total > 0 ? Math.max(0, x) / total : 0);
  const out: EvalSplits = { feedback: [], validation: [], holdout: [] };
  const fresh: EvalCase[] = [];
  for (const c of sorted) {
    const was = prior[c.id];
    if (was === 'feedback' || was === 'validation' || was === 'holdout') out[was].push(c);
    else fresh.push(c);
  }
  let holdoutTarget = Math.round(n * share(ratios.holdout));
  if (n >= 3) holdoutTarget = Math.max(1, holdoutTarget);
  holdoutTarget = Math.min(holdoutTarget, n);
  const feedbackTarget = Math.round(n * share(ratios.feedback));
  const needH = Math.min(fresh.length, Math.max(0, holdoutTarget - out.holdout.length));
  let needF = Math.min(fresh.length - needH, Math.max(0, feedbackTarget - out.feedback.length));
  // With 3+ cases keep validation non-empty so selection has data.
  if (n >= 3 && out.validation.length + (fresh.length - needH - needF) < 1) needF = Math.max(0, needF - 1);
  out.feedback.push(...fresh.slice(0, needF));
  out.holdout.push(...fresh.slice(fresh.length - needH));
  out.validation.push(...fresh.slice(needF, fresh.length - needH));
  const byAgeSort = (list: EvalCase[]) => list.sort(byAge);
  const assignment: SplitAssignment = { ...prior };
  for (const name of ['feedback', 'validation', 'holdout'] as const) {
    byAgeSort(out[name]);
    for (const c of out[name]) assignment[c.id] = name;
  }
  return { ...out, assignment };
}

/** Ids of goal runs derived from holdout cases (the harvested run, or any run with the same goal text). */
export function holdoutRunIds(runs: { id: string; goal?: string }[], holdout: EvalCase[]): Set<string> {
  const ids = new Set(holdout.flatMap((c) => [c.id, c.harvestedFrom].filter((x): x is string => !!x)));
  const goals = new Set(holdout.map((c) => c.goal.trim()).filter(Boolean));
  return new Set(runs.filter((r) => ids.has(r.id) || (r.goal !== undefined && goals.has(r.goal.trim()))).map((r) => r.id));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ids or goal text of holdout cases found in a prompt; empty means clean. An id only counts as a whole token. */
export function holdoutLeaks(prompt: string, holdout: EvalCase[]): string[] {
  const leaks: string[] = [];
  for (const c of holdout) {
    const goal = c.goal.trim();
    const idHit = !!c.id && new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(c.id)}(?![A-Za-z0-9._-])`).test(prompt);
    if (idHit || (goal && prompt.includes(goal))) leaks.push(c.id);
  }
  return leaks;
}

export function promptHasNoHoldout(prompt: string, holdout: EvalCase[]): boolean {
  return holdoutLeaks(prompt, holdout).length === 0;
}
