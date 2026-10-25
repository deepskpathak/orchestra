// W7.1: land a task that was held for approval. Runs after the conductor has finished, so the
// integration worktree is gone; merge in a short-lived worktree on the integration branch.
import { rmSync } from 'node:fs';
import { canApprove } from './oversight.ts';
import * as g from './git.ts';
import type { Store } from './store.ts';
import type { Run } from './types.ts';

export async function approveTask(store: Store, runId: string, taskId: string, by: string): Promise<Run> {
  const run = store.loadRun(runId);
  if (!run) throw new Error(`unknown run "${runId}"`);
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task "${taskId}" in run ${runId}`);
  if (task.status !== 'awaiting_approval') throw new Error(`${taskId} is ${task.status}, not awaiting_approval`);
  const verdict = canApprove({ approver: by, requester: run.requestedBy ?? '' });
  if (!verdict.ok) throw new Error(`approval refused: ${verdict.reason}`);
  if (!run.integrationBranch || !task.branch) throw new Error(`${taskId} has no branch to merge`);

  const path = store.path('worktrees', runId, `_approve-${taskId}`);
  rmSync(path, { recursive: true, force: true });
  g.git(store.root, 'worktree', 'add', '-q', path, run.integrationBranch);
  try {
    const m = g.merge(path, task.branch, `Merge ${task.id}: ${task.title} (approved by ${by})`);
    if (!m.ok) throw new Error(`${taskId} conflicts with the integration branch: ${m.detail.slice(0, 300)}`);
    const cmd = store.config().testCommand;
    if (cmd) {
      const t = await g.runTestsAsync(path, cmd);
      if (!t.ok) throw new Error(`post-merge tests fail, ${taskId} not merged:\n${t.tail.slice(-800)}`);
    }
  } catch (e) {
    g.tryGit(path, 'merge', '--abort');
    g.removeWorktree(store.root, path);
    throw e;
  }
  g.removeWorktree(store.root, path);

  const now = Date.now();
  task.status = 'merged';
  task.endedAt = now;
  task.approval = { ...(task.approval ?? { requestedAt: now }), by, decidedAt: now };
  if (run.tasks.every((t) => t.status === 'merged')) {
    run.status = 'done';
    delete run.error;
  }
  store.saveRun(run);
  store.event({ t: now, run: runId, kind: 'task.merged', msg: `${taskId} merged after approval by ${by}`, task: taskId });
  store.ledger({
    t: now, run: runId, kind: run.kind, harness: run.harness, role: 'worker', task: taskId, attempt: task.attempts,
    model: '', ok: true, costUsd: 0, durationMs: 0, turns: 0, outcome: 'merged', score: task.verdict?.score,
  });
  return run;
}
