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

/** Ids or goal text of holdout cases found in a prompt; empty means clean. */
export function holdoutLeaks(prompt: string, holdout: EvalCase[]): string[] {
  const leaks: string[] = [];
  for (const c of holdout) {
    const goal = c.goal.trim();
    if ((c.id && prompt.includes(c.id)) || (goal && prompt.includes(goal))) leaks.push(c.id);
  }
  return leaks;
}

export function promptHasNoHoldout(prompt: string, holdout: EvalCase[]): boolean {
  return holdoutLeaks(prompt, holdout).length === 0;
}
