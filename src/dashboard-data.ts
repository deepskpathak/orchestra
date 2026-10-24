// Read-only data access shared by the web dashboard and the terminal UI, so both show
// exactly the same thing. No writes; the only command run is the existing `git diff`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { git } from './git.ts';
import { collectOutcomes, type OutcomeMetrics } from './outcomes.ts';
import { currentVersion, loadHarness } from './harness.ts';
import type { Store } from './store.ts';
import type { Run } from './types.ts';

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

export function infoSnapshot(store: Store) {
  return { harness: currentVersion(store), current: store.currentRunId(), repo: store.root, ...harnessLimits(store), outcomes: cachedOutcomes(store) };
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
