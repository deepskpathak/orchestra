// Pure logic for harder and imported eval cases (W3.2): add, human-fix harvest, listing filters and the
// solution-leakage audit. No file or process IO; the CLI injects the diff reader and does the writing.
import type { EvalCase } from './evolve.ts';
import type { Lesson } from './learnings.ts';
import type { Run } from './types.ts';

export const REGRESSION_TAG = 'regression';
export const HARVEST_MAX_SATISFACTION = 0.8; // runs below this (or not done) count as failed or low-satisfaction
const MIN_SIGNIFICANT = 24; // shortest reference line or goal text that counts as a leak when quoted
const MAX_REFERENCE_CHARS = 60_000;

/** Reads the unified diff between two commits. Injected so this module stays pure and testable. */
export type DiffReader = (base: string, fix: string) => string;

export interface AddOptions {
  goal: string;
  base: string;
  check?: string | null;
  id?: string;
  tags?: string[];
  regression?: boolean;
  reference?: string;
}

export interface Finding { caseId: string; kind: 'goal-diff' | 'goal-reference' | 'lesson-reference' | 'lesson-goal' | 'invalid'; detail: string }

function slug(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'case';
}

function uniq(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

/** A manually added case. Throws on unusable input so the CLI can print one clear line. */
export function buildAddedCase(opts: AddOptions, existingIds: string[], now: number): EvalCase {
  const goal = opts.goal.trim();
  if (!goal) throw new Error('A goal is required: orchestra evals add "<goal>"');
  if (!opts.base.trim()) throw new Error('A base commit is required');
  const id = opts.id?.trim() || uniqueId(`m-${slug(goal)}`, existingIds, now);
  if (existingIds.includes(id)) throw new Error(`An eval case with id "${id}" already exists`);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid case id "${id}": use letters, digits, dot, dash and underscore`);
  const tags = uniq([...(opts.tags ?? []), ...(opts.regression ? [REGRESSION_TAG] : [])]);
  const c: EvalCase = { id, goal, base: opts.base.trim(), check: opts.check ?? null, source: normalizeGoal(goal), taskType: 'unknown', createdAt: now };
  if (tags.length) c.tags = tags;
  if (opts.reference) c.reference = opts.reference;
  return c;
}

function uniqueId(prefix: string, existing: string[], now: number): string {
  if (!existing.includes(prefix)) return prefix;
  return `${prefix}-${now.toString(36)}`;
}

function normalizeGoal(goal: string): string {
  return goal.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Whether a finished run is a harvest candidate for a human fix: failed, or done with low satisfaction. */
export function harvestableRun(run: Run): string | null {
  if (run.kind !== 'goal') return `run ${run.id} is an eval run, not a goal run`;
  if (!run.endedAt) return `run ${run.id} has not finished`;
  if (!run.baseRef) return `run ${run.id} has no recorded base commit`;
  if (run.status === 'done' && (run.satisfaction ?? 0) >= HARVEST_MAX_SATISFACTION) {
    return `run ${run.id} succeeded (satisfaction ${(run.satisfaction ?? 0).toFixed(2)}); successful runs are harvested automatically`;
  }
  return null;
}

/**
 * Turns a failed or low-satisfaction goal run plus the commit a human later wrote into an eval case. The human fix
 * (diff from the run's base to the fix) becomes `reference`, which is never shown to workers. Throws with a clear
 * message when the run is not harvestable or the fix does not differ from the base.
 */
export function buildHarvestedCase(run: Run, fix: string, readDiff: DiffReader, check: string | null | undefined, existingIds: string[], now: number): EvalCase {
  const why = harvestableRun(run);
  if (why) throw new Error(why);
  const diff = readDiff(run.baseRef!, fix).trim();
  if (!diff) throw new Error(`Fix ${fix} makes no change relative to the base of run ${run.id}`);
  const id = `h-${run.id}`;
  if (existingIds.includes(id)) throw new Error(`Run ${run.id} is already harvested as ${id}`);
  const reference = diff.length > MAX_REFERENCE_CHARS ? `${diff.slice(0, MAX_REFERENCE_CHARS)}\n... [reference truncated, ${diff.length} chars total]` : diff;
  return {
    id,
    goal: run.goal,
    base: run.baseRef!,
    check: check ?? null,
    harvestedFrom: run.id,
    source: normalizeGoal(run.goal),
    taskType: run.domain || 'unknown',
    createdAt: now,
    tags: ['human-fix', REGRESSION_TAG],
    reference,
  };
}

/** Cases carrying every given tag; no tags means all cases. */
export function filterByTags(cases: EvalCase[], tags: string[]): EvalCase[] {
  if (!tags.length) return cases;
  return cases.filter((c) => tags.every((t) => (c.tags ?? []).includes(t)));
}

export function regressionSuite(cases: EvalCase[]): EvalCase[] {
  return filterByTags(cases, [REGRESSION_TAG]);
}

/** Added lines of a unified diff, or every non-empty line for plain text, trimmed and long enough to be telling. */
export function significantLines(reference: string): string[] {
  const out = new Set<string>();
  for (const raw of reference.split('\n')) {
    if (/^(\+\+\+|---|diff |index |@@)/.test(raw)) continue;
    const line = raw.replace(/^\+/, '').trim();
    if (line.length >= MIN_SIGNIFICANT) out.add(line);
  }
  return [...out];
}

const DIFF_MARKERS = /^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@|\+\+\+ b\/|--- a\/)/m;

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Solution-leakage audit over cases and lesson texts. A case leaks when its goal embeds a unified diff or quotes a
 * telling line of its own reference fix, or when a lesson quotes the reference or the goal text of a case. Lessons
 * are shown to workers, so a quoted answer there would inflate scores. Pure: lessons are passed in.
 */
export function auditCases(cases: EvalCase[], lessons: Pick<Lesson, 'lesson'>[] = []): Finding[] {
  const findings: Finding[] = [];
  const lessonTexts = lessons.map((l) => squash(l.lesson));
  for (const c of cases) {
    if (!c || typeof c.id !== 'string' || typeof c.goal !== 'string' || typeof c.base !== 'string' || !c.goal.trim() || !c.base.trim()) {
      findings.push({ caseId: String(c?.id ?? '?'), kind: 'invalid', detail: 'case is missing id, goal or base' });
      continue;
    }
    if (DIFF_MARKERS.test(c.goal)) findings.push({ caseId: c.id, kind: 'goal-diff', detail: 'goal text contains a unified diff' });
    const refLines = c.reference ? significantLines(c.reference) : [];
    const goalSq = squash(c.goal);
    const inGoal = refLines.find((l) => goalSq.includes(squash(l)));
    if (inGoal) findings.push({ caseId: c.id, kind: 'goal-reference', detail: `goal quotes the reference fix: "${clip(inGoal)}"` });
    const goalKey = goalSq.length >= MIN_SIGNIFICANT ? goalSq : '';
    for (let i = 0; i < lessonTexts.length; i++) {
      const t = lessonTexts[i]!;
      const hit = refLines.find((l) => t.includes(squash(l)));
      if (hit) findings.push({ caseId: c.id, kind: 'lesson-reference', detail: `a lesson quotes the reference fix: "${clip(hit)}"` });
      else if (goalKey && t.includes(goalKey)) findings.push({ caseId: c.id, kind: 'lesson-goal', detail: `a lesson quotes the full goal text: "${clip(goalKey)}"` });
    }
  }
  return findings;
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ${f.caseId}  [${f.kind}] ${f.detail}`).join('\n');
}
