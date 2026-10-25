// Read-only data access shared by the web dashboard and the terminal UI, so both show
// exactly the same thing. No writes; the only command run is the existing `git diff`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { git } from './git.ts';
import { cacheReadShare } from './cost.ts';
import { oversightMetrics, type OversightRecord } from './oversight.ts';
import { conflictRate } from './throughput.ts';
import { collectOutcomes, type OutcomeMetrics } from './outcomes.ts';
import { currentVersion, loadHarness } from './harness.ts';
import type { Store } from './store.ts';
import type { Run, Task } from './types.ts';

// Bump when the /api payload shape changes incompatibly.
export const API_SCHEMA = 1;

const LOG_TAIL_BYTES = 40_000;

export function listRunSummaries(store: Store) {
  return store
    .listRuns()
    .reverse()
    .map((id) => store.loadRun(id))
    .filter((r): r is Run => Boolean(r))
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      kind: r.kind,
      harness: r.harness,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      costUsd: r.costUsd,
      satisfaction: r.satisfaction ?? null,
      tasks: r.tasks.length,
      merged: r.tasks.filter((t) => t.status === 'merged').length,
      needsHuman: r.tasks.filter((t) => t.status === 'needs_human').length,
    }));
}

// Retry and pass limits of the current harness, so the board can show "try 2 of 3" and the pass line.
export function harnessLimits(store: Store): { maxAttempts?: number; passThreshold?: number } {
  try {
    const { maxAttempts, passThreshold } = loadHarness(store).config;
    return { maxAttempts, passThreshold };
  } catch {
    return {}; // harness missing or unreadable: callers simply omit these
  }
}

// collectOutcomes shells out to git several times per run, and /api/info is polled every few seconds per tab.
// Reuse the last result while the runs look the same and no branch has moved; the TTL bounds staleness for
// changes this key cannot see (new bench results).
const OUTCOMES_TTL_MS = 30_000;
const outcomesCache = new Map<string, { key: string; at: number; value: OutcomeMetrics }>();

function cachedOutcomes(store: Store): OutcomeMetrics {
  const runs = store.listRuns().map((id) => store.loadRun(id)).filter((r): r is Run => Boolean(r));
  let head = '';
  try {
    head = git(store.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'); // one cheap call; any branch move or prune changes the key
  } catch {
    head = ''; // not a repo: the key falls back to runs alone
  }
  const key = JSON.stringify([head, runs.map((r) => [r.id, r.status, r.endedAt ?? null, r.costUsd, r.integrationBranch ?? null, r.tasks.map((t) => t.status)])]);
  const hit = outcomesCache.get(store.root);
  if (hit && hit.key === key && Date.now() - hit.at < OUTCOMES_TTL_MS) return hit.value;
  const value = collectOutcomes(store);
  outcomesCache.set(store.root, { key, at: Date.now(), value });
  return value;
}

// ---- oversight and throughput (W7.2) ----

export interface RunOversight {
  runId: string;
  interruptions: number; // needs_human stops plus approval requests
  reviewMinutes: number; // approval requested to decided, summed over decided approvals
  edits: number; // human commits on the integration branch between approval request and merge
  conflictRate: number | null; // Run.conflictRate; null for runs recorded before W6.1
  meanMergeWaitMs: number | null; // judged-pass to landed, mean over tasks that recorded it
  cacheReadShare: number | null; // Run.cacheReadShare; null without token data
}
export interface OversightSummary {
  runs: RunOversight[];
  total: { runs: number; interruptions: number; reviewMinutes: number; edits: number; conflictRate: number | null; meanMergeWaitMs: number | null; cacheReadShare: number | null };
}

// Human commits on `branch` made between two instants: not merges and not authored by Orchestra.
export type HumanCommits = (root: string, branch: string, fromMs: number, toMs: number) => number;
export const gitHumanCommits: HumanCommits = (root, branch, fromMs, toMs) => {
  try {
    const out = git(root, 'log', branch, '--no-merges', '--format=%at\t%an');
    return out.split('\n').filter(Boolean).filter((l) => {
      const [at, author] = l.split('\t');
      const ms = Number(at) * 1000;
      return author !== 'Orchestra' && ms >= fromMs - 1000 && ms <= toMs;
    }).length;
  } catch {
    return 0; // branch pruned or not a repo: no edits can be shown
  }
};

const iso = (ms: number) => new Date(ms).toISOString();
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Approval records and needs_human stops on runs become oversight metrics through oversightMetrics; the
// throughput numbers come from what the conductor stored on each run. A run with none of these shows zeros.
export function oversightSummary(store: Store, humanCommits: HumanCommits = gitHumanCommits): OversightSummary {
  const runs = store.listRuns().map((id) => store.loadRun(id)).filter((r): r is Run => Boolean(r) && r!.kind !== 'eval');
  const records: OversightRecord[] = [];
  for (const r of runs) {
    records.push({ runId: r.id }); // keeps a zero row for runs without any oversight events
    for (const t of r.tasks) {
      const a = t.approval;
      if (t.status !== 'needs_human' && !a) continue;
      records.push({
        runId: r.id,
        taskId: t.id,
        needsHuman: t.status === 'needs_human',
        ...(a ? { requestedAt: iso(a.requestedAt), ...(a.decidedAt ? { decidedAt: iso(a.decidedAt) } : {}) } : {}),
        ...(a?.decidedAt && r.integrationBranch ? { humanCommits: humanCommits(store.root, r.integrationBranch, a.requestedAt, a.decidedAt) } : {}),
      });
    }
  }
  const byRun = new Map(oversightMetrics(records).map((m) => [m.runId, m]));
  const waits = (r: Run) => r.tasks.filter((t: Task) => typeof t.mergeWaitMs === 'number').map((t) => t.mergeWaitMs!);
  const rows: RunOversight[] = runs.map((r) => {
    const m = byRun.get(r.id) ?? { interruptions: 0, reviewMinutes: 0, edits: 0 };
    return { runId: r.id, interruptions: m.interruptions, reviewMinutes: round1(m.reviewMinutes), edits: m.edits, conflictRate: r.conflictRate ?? null, meanMergeWaitMs: mean(waits(r)), cacheReadShare: r.cacheReadShare ?? null };
  });
  // Pooled across runs: conflicts over all merge attempts, and cache reads over all input tokens.
  const known = new Set(runs.filter((r) => r.conflictRate !== undefined).map((r) => r.id));
  const ledger = store.ledgerRows();
  const share = cacheReadShare(ledger.filter((l) => runs.some((r) => r.id === l.run)));
  return {
    runs: rows,
    total: {
      runs: rows.length,
      interruptions: rows.reduce((a, r) => a + r.interruptions, 0),
      reviewMinutes: round1(rows.reduce((a, r) => a + r.reviewMinutes, 0)),
      edits: rows.reduce((a, r) => a + r.edits, 0),
      conflictRate: known.size ? conflictRate(ledger.filter((l) => known.has(l.run))) : null,
      meanMergeWaitMs: mean(runs.flatMap(waits)),
      cacheReadShare: share ?? null,
    },
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function renderOversight(o: OversightSummary): string {
  const t = o.total;
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const wait = t.meanMergeWaitMs === null ? 'n/a' : `${(t.meanMergeWaitMs / 1000).toFixed(1)}s`;
  return [
    `Oversight and throughput (${t.runs} goal run${t.runs === 1 ? '' : 's'})`,
    `  Interruptions:      ${t.interruptions}`,
    `  Review minutes:     ${t.reviewMinutes}`,
    `  Edits before landing: ${t.edits}`,
    `  Conflict rate:      ${pct(t.conflictRate)}`,
    `  Mean merge wait:    ${wait}`,
    `  Cache-read share:   ${pct(t.cacheReadShare)}`,
  ].join('\n');
}

// /api/info is polled; the oversight numbers only change when runs do, so a few seconds of reuse is plenty.
const OVERSIGHT_TTL_MS = 5_000;
const oversightCache = new Map<string, { at: number; value: OversightSummary }>();
function cachedOversight(store: Store): OversightSummary {
  const hit = oversightCache.get(store.root);
  if (hit && Date.now() - hit.at < OVERSIGHT_TTL_MS) return hit.value;
  const value = oversightSummary(store);
  oversightCache.set(store.root, { at: Date.now(), value });
  return value;
}

export function infoSnapshot(store: Store) {
  return { harness: currentVersion(store), current: store.currentRunId(), repo: store.root, ...harnessLimits(store), outcomes: cachedOutcomes(store), oversight: cachedOversight(store) };
}

// Task detail: verdict is already in run.json; add the branch diff and the tail of each agent log.
export function taskDetail(store: Store, runId: string, taskId: string) {
  const run = store.loadRun(runId);
  const task = run?.tasks.find((t) => t.id === taskId);
  if (!run || !task) return null;
  let diff: string | null = null;
  if (task.branch && run.baseRef) {
    try {
      diff = git(store.root, 'diff', '--stat', '--patch', `${run.baseRef}...${task.branch}`).slice(0, 60_000);
    } catch {
      diff = null; // branch pruned after merge, or ref unknown
    }
  }
  const logDir = store.path('runs', runId, 'logs');
  const logs: { name: string; tail: string }[] = [];
  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir).filter((f) => f.startsWith(`${taskId}-`)).sort()) {
      const text = readFileSync(`${logDir}/${name}`, 'utf8');
      logs.push({ name, tail: text.slice(-LOG_TAIL_BYTES) });
    }
  }
  return { schema: API_SCHEMA, task, diff, logs };
}
