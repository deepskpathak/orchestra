// Outcome metrics beyond satisfaction (W2.6): did the work land, how much was edited first, was it
// reverted, what did an accepted merge cost, and how success varies with task length.
// The aggregation is pure (plain data in, numbers out) so it is testable without git. The collector
// at the bottom does the read-only git lookups and tolerates missing branches. A rate with a zero
// denominator is null and renders as n/a.

import { readBenchRows } from './calibration.ts';
import { git } from './git.ts';
import type { Store } from './store.ts';
import type { Run } from './types.ts';

// What git says about one run's integration branch. Absent facts mean "not landed".
export interface RunGitFacts {
  landed: boolean; // integration tip reachable from main, or every commit patch-equivalent on main
  editLines?: number; // lines in run-touched files that differ between the integration tip and main
  reverted?: boolean; // a later commit on main reverts one of the run's commits
  fixups?: number; // later fix-like commits on main touching the run's files
}

export interface BenchOutcomeRow {
  humanMinutes: number;
  pass: boolean;
}

export interface Bucket {
  label: string;
  runs: number;
  succeeded: number;
  rate: number | null;
}

export interface OutcomeMetrics {
  candidates: number; // goal runs that produced at least one merged task
  accepted: number;
  acceptanceRate: number | null;
  unedited: number; // accepted runs that landed with no edits
  meanEditLines: number | null; // among accepted runs
  revertRate: number | null; // reverted / accepted
  breakageRate: number | null; // (reverted or followed by a fix) / accepted
  costPerAcceptedUsd: number | null; // total goal-run spend / accepted
  wallClockPerAcceptedMs: number | null;
  byTaskCount: Bucket[];
  byGoalLength: Bucket[];
  byHumanMinutes: Bucket[]; // bench rows only; empty when there are none
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

function bucketize(items: { value: number; ok: boolean }[], edges: { label: string; max: number }[]): Bucket[] {
  const out = edges.map((e) => ({ label: e.label, runs: 0, succeeded: 0, rate: null as number | null }));
  for (const it of items) {
    const i = edges.findIndex((e) => it.value <= e.max);
    const b = out[i < 0 ? out.length - 1 : i];
    b.runs++;
    if (it.ok) b.succeeded++;
  }
  for (const b of out) b.rate = ratio(b.succeeded, b.runs);
  return out.filter((b) => b.runs > 0);
}

const TASK_COUNT_EDGES = [{ label: '1 task', max: 1 }, { label: '2-3 tasks', max: 3 }, { label: '4-6 tasks', max: 6 }, { label: '7+ tasks', max: Infinity }];
const GOAL_LENGTH_EDGES = [{ label: 'goal <80 chars', max: 79 }, { label: 'goal 80-199 chars', max: 199 }, { label: 'goal 200+ chars', max: Infinity }];
const HUMAN_MIN_EDGES = [{ label: '<=15 min', max: 15 }, { label: '16-60 min', max: 60 }, { label: '1-4 h', max: 240 }, { label: '>4 h', max: Infinity }];

export function computeOutcomes(runs: Run[], facts: Record<string, RunGitFacts | undefined>, bench: BenchOutcomeRow[] = []): OutcomeMetrics {
  const goals = runs.filter((r) => r.kind === 'goal');
  const candidates = goals.filter((r) => r.tasks.some((t) => t.status === 'merged'));
  const accepted = candidates.filter((r) => facts[r.id]?.landed);

  const edits = accepted.map((r) => facts[r.id]?.editLines ?? 0);
  const reverted = accepted.filter((r) => facts[r.id]?.reverted).length;
  const broken = accepted.filter((r) => facts[r.id]?.reverted || (facts[r.id]?.fixups ?? 0) > 0).length;
  const spend = goals.reduce((s, r) => s + r.costUsd, 0);
  const wall = goals.reduce((s, r) => s + Math.max(0, (r.endedAt ?? r.startedAt) - r.startedAt), 0);
  const ok = (r: Run) => r.status === 'done';

  return {
    candidates: candidates.length,
    accepted: accepted.length,
    acceptanceRate: ratio(accepted.length, candidates.length),
    unedited: edits.filter((e) => e === 0).length,
    meanEditLines: ratio(edits.reduce((a, b) => a + b, 0), accepted.length),
    revertRate: ratio(reverted, accepted.length),
    breakageRate: ratio(broken, accepted.length),
    costPerAcceptedUsd: ratio(spend, accepted.length),
    wallClockPerAcceptedMs: ratio(wall, accepted.length),
    byTaskCount: bucketize(goals.map((r) => ({ value: r.tasks.length, ok: ok(r) })), TASK_COUNT_EDGES),
    byGoalLength: bucketize(goals.map((r) => ({ value: r.goal.length, ok: ok(r) })), GOAL_LENGTH_EDGES),
    byHumanMinutes: bucketize(bench.map((b) => ({ value: b.humanMinutes, ok: b.pass })), HUMAN_MIN_EDGES),
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(2)}`);
const mins = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 60_000).toFixed(1)} min`);

export function renderOutcomes(m: OutcomeMetrics): string {
  const lines = [
    'Outcome metrics (beyond satisfaction)',
    `  merge acceptance      ${pct(m.acceptanceRate)} (${m.accepted} of ${m.candidates} runs with merged work reached main)`,
    `  edits before landing  ${m.meanEditLines === null ? 'n/a' : `${m.meanEditLines.toFixed(1)} lines on average, ${m.unedited} of ${m.accepted} landed unedited`}`,
    `  revert rate           ${pct(m.revertRate)}   breakage proxy ${pct(m.breakageRate)}`,
    `  per accepted merge    ${usd(m.costPerAcceptedUsd)}, ${mins(m.wallClockPerAcceptedMs)}`,
  ];
  const section = (title: string, bs: Bucket[]) => {
    if (bs.length) lines.push(`  ${title}: ${bs.map((b) => `${b.label} ${pct(b.rate)} (${b.succeeded}/${b.runs})`).join(', ')}`);
  };
  section('success by task count', m.byTaskCount);
  section('success by goal length', m.byGoalLength);
  section('bench pass by human time', m.byHumanMinutes);
  return lines.join('\n');
}

// ---- collector (read-only git) ----

function tryOut(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

function mainBranch(root: string): string | null {
  for (const b of ['main', 'master']) if (tryOut(root, 'rev-parse', '--verify', '-q', b) !== null) return b;
  return tryOut(root, 'symbolic-ref', '--short', 'HEAD');
}

const FIX_RE = /\b(fix|hotfix|regression|broke|broken)\b/i;

export function gitFactsForRun(root: string, run: Run, main: string): RunGitFacts {
  const branch = run.integrationBranch;
  if (!branch || !run.baseRef || tryOut(root, 'rev-parse', '--verify', '-q', branch) === null) return { landed: false };
  const ancestor = tryOut(root, 'merge-base', '--is-ancestor', branch, main) !== null;
  let landed = ancestor;
  if (!landed) {
    // Squash or rebase landings: every commit has a patch-equivalent on main (git cherry marks those with "-").
    const cherry = tryOut(root, 'cherry', main, branch);
    landed = !!cherry && !cherry.split('\n').some((l) => l.startsWith('+'));
  }
  if (!landed) return { landed: false };

  const files = (tryOut(root, 'diff', '--name-only', `${run.baseRef}...${branch}`) ?? '').split('\n').filter(Boolean);
  let editLines = 0;
  if (files.length) {
    const stat = tryOut(root, 'diff', '--numstat', branch, main, '--', ...files) ?? '';
    for (const l of stat.split('\n').filter(Boolean)) {
      const [a, d] = l.split('\t');
      editLines += (Number(a) || 0) + (Number(d) || 0);
    }
  }

  const runCommits = new Set((tryOut(root, 'rev-list', `${run.baseRef}..${branch}`) ?? '').split('\n').filter(Boolean));
  const later = ancestor ? `${branch}..${main}` : `${run.baseRef}..${main}`;
  const bodies = tryOut(root, 'log', later, '--format=%H%x1f%s%x1f%b%x1e') ?? '';
  let reverted = false;
  let fixups = 0;
  for (const rec of bodies.split('\x1e').map((s) => s.trim()).filter(Boolean)) {
    const [sha, subject, body = ''] = rec.split('\x1f');
    for (const m of body.matchAll(/This reverts commit ([0-9a-f]{40})/g)) if (runCommits.has(m[1])) reverted = true;
    if (!runCommits.has(sha) && FIX_RE.test(subject) && files.length && tryOut(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha, '--', ...files)) fixups++;
  }
  return { landed: true, editLines, reverted, fixups };
}

// Bench results live at <store>/bench/<benchId>/results.jsonl; readBenchRows knows that layout.
function benchRows(store: Store): BenchOutcomeRow[] {
  try {
    return readBenchRows(store).filter((r) => typeof r.humanMinutes === 'number' && typeof r.checkPass === 'boolean').map((r) => ({ humanMinutes: r.humanMinutes, pass: r.checkPass }));
  } catch {
    return []; // a corrupt results file must not take the stats screen down
  }
}

export function collectOutcomes(store: Store): OutcomeMetrics {
  const runs = store.listRuns().map((id) => store.loadRun(id)).filter((r): r is Run => Boolean(r));
  const main = mainBranch(store.root);
  const facts: Record<string, RunGitFacts> = {};
  if (main) for (const r of runs) facts[r.id] = gitFactsForRun(store.root, r, main);
  return computeOutcomes(runs, facts, benchRows(store));
}
