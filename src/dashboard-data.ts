// Read-only data access shared by the web dashboard and the terminal UI, so both show
// exactly the same thing. No writes; the only command run is the existing `git diff`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { git } from './git.ts';
import { collectOutcomes } from './outcomes.ts';
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

export function infoSnapshot(store: Store) {
  return { harness: currentVersion(store), current: store.currentRunId(), repo: store.root, ...harnessLimits(store), outcomes: collectOutcomes(store) };
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
