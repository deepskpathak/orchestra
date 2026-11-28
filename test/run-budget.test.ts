import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRequest, AgentResult, Runner } from '../src/agent.ts';
import { isBudgetRefusal, MIN_SESSION_USD, runBudgetReason, runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { probeSessionCost, type ProbeExec } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

const task = (id: string) => ({ id, title: id, description: id, acceptance: [`${id} done`], deps: [], footprint: { files: [`fake/${id}.txt`] } });

// Fake runner with a fixed plan and a fixed spend per role. Every request is recorded before it is served.
function priced(tasks: any[], cost: Partial<Record<AgentRequest['role'], number>>, opts: { hold?: Promise<void> } = {}) {
  const reqs: AgentRequest[] = [];
  const inner = fakeRunner({ failFirstAttemptOf: [] });
  const runner: Runner = async (req) => {
    reqs.push(req);
    if (req.role === 'planner') return { ok: true, text: '', costUsd: cost.planner ?? 0.01, turns: 1, durationMs: 1, structured: { tasks, scenarios: [] } };
    if (req.role === 'worker' && opts.hold) await opts.hold;
    const res: AgentResult = await inner(req);
    return { ...res, costUsd: cost[req.role] ?? res.costUsd };
  };
  return { runner, reqs };
}

test('run budget: each session cap is cut to what is left of the run', async () => {
  const store = tempRepo({ runBudgetUsd: 2.5 });
  const { runner, reqs } = priced([task('T1')], { planner: 1, worker: 0.5, judge: 0.2, librarian: 0.1 });
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.status, 'done');
  const cap = (role: string) => reqs.find((r) => r.role === role)!.budgetUsd;
  assert.equal(cap('planner'), 2, 'harness cap when the run has room for it');
  assert.equal(cap('worker'), 1.5, 'worker cap 3 cut to 2.5 - 1 spent');
  assert.equal(cap('judge'), 1, 'judge cap 1 fits in the 1.0 left');
  assert.equal(cap('librarian'), 0.8, 'librarian cap 1 cut to 2.5 - 1.7 spent');
  assert.ok(run.costUsd <= 2.5);
});

test('run budget: once spend reaches the ceiling nothing else starts, librarian included', async () => {
  const store = tempRepo({ runBudgetUsd: 1 });
  const { runner, reqs } = priced([task('T1')], { planner: 0.98 });
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.deepEqual(reqs.map((r) => r.role), ['planner'], 'no worker, judge or librarian session after the planner used the budget');
  assert.equal(run.tasks[0].status, 'failed');
  assert.ok(run.costUsd <= 1, `spent ${run.costUsd} against a $1 ceiling`);
  const events = store.events(run.id);
  assert.ok(events.some((e) => e.kind === 'task.failed' && e.msg.includes(runBudgetReason(1))));
  assert.ok(events.some((e) => /^librarian not started: run budget \$1 exhausted/.test(e.msg)));
  assert.equal(store.ledgerRows().some((r) => r.role === 'librarian'), false, 'a refused session writes no ledger row');
});

test('run budget: spend left under the session minimum fails the task before any worker starts', async () => {
  // Planner leaves 0.04, under MIN_SESSION_USD, so the scheduler fails the task instead of dispatching it.
  const store = tempRepo({ runBudgetUsd: 1 });
  const { runner, reqs } = priced([task('T1')], { planner: 1 - MIN_SESSION_USD + 0.01 });
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.tasks[0].attempts, 0);
  assert.equal(reqs.some((r) => r.role === 'judge'), false);
});

test('run budget: concurrent sessions reserve their caps, so together they cannot pass the ceiling', async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const store = tempRepo({ runBudgetUsd: 4.01, concurrency: 2 });
  const { runner, reqs } = priced([task('T1'), task('T2')], { planner: 0.01, worker: 0.2, judge: 0.1, librarian: 0.1 }, { hold });
  const done = runGoal({ store, runner, goal: 'g' });
  // Let both workers be dispatched, then release them together.
  for (let i = 0; i < 50 && reqs.filter((r) => r.role === 'worker').length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const workers = reqs.filter((r) => r.role === 'worker');
  assert.equal(workers.length, 2);
  assert.equal(workers[0].budgetUsd, 3);
  assert.equal(workers[1].budgetUsd, 1, 'second worker gets 4.01 - 0.01 spent - 3 reserved');
  release();
  const run = await done;
  assert.equal(run.status, 'done');
});

test('run budget: sandbox pre-flight probe spend counts as run spend and is in the ledger', async () => {
  const store = tempRepo({ runBudgetUsd: 20 });
  const probeOut = `${JSON.stringify({ type: 'result', total_cost_usd: 0.07, result: 'ORCHESTRA_PROBE_BLOCKED' })}\n`;
  const exec: ProbeExec = (c) => (c === 'node' ? { status: 0, stdout: 'ORCHESTRA_PROBE_OPEN\n', stderr: '' } : { status: 0, stdout: probeOut, stderr: '' });
  const { runner } = priced([task('T1')], { planner: 0.01, worker: 0.01, judge: 0.01, librarian: 0.01 });
  const run = await runGoal({ store, runner, goal: 'g', sandbox: { backend: 'claude' }, preflightExec: exec });
  assert.equal(run.status, 'done');
  const probe = store.ledgerRows().filter((r) => r.outcome === 'sandbox_preflight');
  assert.equal(probe.length, 1);
  assert.equal(probe[0].costUsd, 0.14, 'two probe sessions at $0.07 each');
  assert.equal(run.costUsd, 0.18, 'probes plus four $0.01 sessions');
});

test('probeSessionCost takes the largest cumulative total_cost_usd and skips non-JSON lines', () => {
  const out = ['noise', JSON.stringify({ type: 'assistant' }), JSON.stringify({ type: 'result', total_cost_usd: 0.1 }), '{"result": broken', JSON.stringify({ type: 'result', total_cost_usd: 0.25 })].join('\n');
  assert.equal(probeSessionCost(out), 0.25);
  assert.equal(probeSessionCost(''), 0);
});

test('isBudgetRefusal only matches a session that never started', () => {
  const refused: AgentResult = { ok: false, text: '', costUsd: 0, turns: 0, durationMs: 0, error: runBudgetReason(5) };
  assert.equal(isBudgetRefusal(refused), true);
  assert.equal(isBudgetRefusal({ ...refused, costUsd: 0.2 }), false, 'a session that spent money ran');
  assert.equal(isBudgetRefusal({ ...refused, error: 'max budget' }), false);
});

test('run budget: a session blocked only by a sibling reservation waits for it instead of failing its task', async () => {
  // Both workers are dispatched in one scheduler pass. The first reserves the whole $3 left, so the second
  // must wait for it to settle (pilot b20261128035158 failed T2 here with "run budget $3 exhausted").
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const store = tempRepo({ runBudgetUsd: 3.01, concurrency: 2 });
  const { runner, reqs } = priced([task('T1'), task('T2')], { planner: 0.01, worker: 0.2, judge: 0.1, librarian: 0.1 }, { hold });
  const done = runGoal({ store, runner, goal: 'g' });
  for (let i = 0; i < 50 && !reqs.some((r) => r.role === 'worker'); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reqs.filter((r) => r.role === 'worker').length, 1, 'the second worker waits rather than starting with no budget');
  release();
  const run = await done;
  assert.deepEqual(run.tasks.map((t) => t.status), ['merged', 'merged']);
  const workers = reqs.filter((r) => r.role === 'worker');
  assert.equal(workers[0].budgetUsd, 3);
  assert.ok(workers[1].budgetUsd >= 2.5 && workers[1].budgetUsd <= 2.8, `second worker cap ${workers[1].budgetUsd} is what was left once the first settled`);
  assert.equal(store.events(run.id).some((e) => /not started/.test(e.msg)), false);
});
