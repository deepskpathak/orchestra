import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { buildArgs, type AgentRequest, type AgentResult, type Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { tempRepo } from './helpers.ts';

const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, description: id, acceptance: [`${id} done`], deps: [], footprint: { files: [`fake/${id}.txt`] }, ...extra });

// Fake runner with a custom plan. `onReq` sees every request before it is served.
function planned(tasks: any[], opts: { confidence?: number; onReq?: (req: AgentRequest) => void; fake?: Parameters<typeof fakeRunner>[0]; after?: (req: AgentRequest, res: AgentResult) => Promise<void> } = {}): Runner {
  const inner = fakeRunner({ failFirstAttemptOf: [], ...(opts.fake ?? {}) });
  return async (req) => {
    opts.onReq?.(req);
    if (req.role === 'planner') {
      const structured: any = { tasks, scenarios: [] };
      if (req.prompt.includes('"confidence"') && opts.confidence !== undefined) structured.confidence = opts.confidence;
      return { ok: true, text: '', costUsd: 0.01, turns: 1, durationMs: 1, structured };
    }
    const res = await inner(req);
    await opts.after?.(req, res);
    return res;
  };
}

const plannerModels = (reqs: AgentRequest[]) => reqs.filter((r) => r.role === 'planner').map((r) => r.model);
const workers = (reqs: AgentRequest[]) => reqs.filter((r) => r.role === 'worker');

test('config: partial W6/W8 blocks keep defaults and everything is off by default', () => {
  const store = tempRepo();
  const d = store.config();
  assert.equal(d.planner!.cascade.enabled, false);
  assert.equal(d.planner!.cascade.draftModel, 'fast');
  assert.equal(d.planner!.cascade.confidenceThreshold, 0.7);
  assert.equal(d.budgets!.workerPrompt.enabled, false);
  assert.equal(d.bestOfN!.enabled, false);
  assert.equal(d.bestOfN!.n, 2);
  assert.equal(d.cache!.discipline.enabled, false);
  assert.equal(d.cache!.discipline.warmFirst, true);
  assert.equal(d.provider, 'claude');
  store.writeJson('config.json', { planner: { cascade: { enabled: true } }, budgets: { workerPrompt: { enabled: true } }, cache: { discipline: { enabled: true } }, bestOfN: { enabled: true } });
  const c = store.config();
  assert.equal(c.planner!.cascade.enabled, true);
  assert.equal(c.planner!.cascade.confidenceThreshold, 0.7);
  assert.equal(c.budgets!.workerPrompt.maxTurns, d.budgets!.workerPrompt.maxTurns);
  assert.equal(c.cache!.discipline.warmFirst, true);
  assert.equal(c.bestOfN!.n, 2);
});

test('buildArgs adds --max-turns only when a cap is set', () => {
  const base: AgentRequest = { role: 'worker', prompt: 'p', system: 's', cwd: '/x', model: 'sonnet', budgetUsd: 1 };
  assert.equal(buildArgs(base).includes('--max-turns'), false);
  const args = buildArgs({ ...base, maxTurns: 7 });
  assert.equal(args[args.indexOf('--max-turns') + 1], '7');
});

test('cascade: a confident clean draft uses only the draft model, and the outcome is logged', async () => {
  const store = tempRepo({ planner: { cascade: { enabled: true, draftModel: 'fast', confidenceThreshold: 0.7 } } });
  const reqs: AgentRequest[] = [];
  const run = await runGoal({ store, runner: planned([task('T1')], { confidence: 0.9, onReq: (r) => reqs.push(r) }), goal: 'g' });
  assert.equal(run.status, 'done');
  assert.deepEqual(plannerModels(reqs), ['haiku']);
  const row = store.ledgerRows().find((r) => r.outcome?.startsWith('plan_cascade'));
  assert.equal(row?.outcome, 'plan_cascade_draft_accepted');
  assert.equal(row?.score, 0.9);
});

test('cascade: a dependency cycle or low confidence triggers exactly one strong-model planner call', async () => {
  for (const [tasks, confidence, reason] of [
    [[task('T1', { deps: ['T2'] }), task('T2', { deps: ['T1'] })], 0.95, /cycle/],
    [[task('T1')], 0.3, /below threshold/],
    [[task('T1')], undefined, /no confidence/],
  ] as const) {
    const store = tempRepo({ planner: { cascade: { enabled: true, draftModel: 'fast', confidenceThreshold: 0.7 } } });
    const reqs: AgentRequest[] = [];
    // The strong call sees no confidence ask; give it a clean plan so the run can proceed.
    const inner = planned([task('T1')], { confidence, onReq: (r) => reqs.push(r) });
    const runner: Runner = async (req) => (req.role === 'planner' && req.model === 'haiku' ? planned(tasks as any, { confidence })(req) : inner(req));
    const run = await runGoal({ store, runner, goal: 'g' });
    assert.equal(run.status, 'done');
    assert.deepEqual(plannerModels(reqs), ['opus']);
    const row = store.ledgerRows().find((r) => r.outcome?.startsWith('plan_cascade'));
    assert.equal(row?.outcome, 'plan_cascade_escalated');
    assert.match(store.events(run.id).find((e) => /Planner cascade/.test(e.msg))!.msg, reason);
  }
});

test('cascade off: one planner call on the harness model and no cascade outcome row', async () => {
  const store = tempRepo();
  const reqs: AgentRequest[] = [];
  await runGoal({ store, runner: planned([task('T1')], { onReq: (r) => reqs.push(r) }), goal: 'g' });
  assert.deepEqual(plannerModels(reqs), ['opus']);
  assert.equal(store.ledgerRows().some((r) => r.outcome?.startsWith('plan_cascade')), false);
});

test('budget: prompt shows turns and dollars remaining, session caps are passed, and the cap stops further attempts', async () => {
  async function go(enabled: boolean) {
    const store = tempRepo({ budgets: { workerPrompt: { enabled, maxTurns: 3 } } });
    const reqs: AgentRequest[] = [];
    const run = await runGoal({ store, runner: planned([task('T1')], { onReq: (r) => reqs.push(r), fake: { failFirstAttemptOf: ['T1'] } }), goal: 'g' });
    return { run, reqs, store };
  }
  const on = await go(true);
  const t1 = on.run.tasks[0];
  assert.equal(t1.status, 'failed');
  assert.equal(t1.attempts, 1, 'no second attempt once the cap is reached');
  assert.match(workers(on.reqs)[0].prompt, /Budget: 3 turns remaining of 3, \$3\.00 remaining of a \$3\.00 hard cap/);
  assert.equal(workers(on.reqs)[0].maxTurns, 3);
  assert.match(on.store.events(on.run.id).find((e) => e.kind === 'task.failed')!.msg, /worker budget cap reached/);

  const off = await go(false);
  assert.equal(off.run.tasks[0].status, 'merged');
  assert.equal(off.run.tasks[0].attempts, 2);
  for (const w of workers(off.reqs)) {
    assert.doesNotMatch(w.prompt, /## Budget/);
    assert.equal('maxTurns' in w, false);
  }
});

test('budget: a passing task at the cap still lands, and the second attempt carries the reduced remainder', async () => {
  const store = tempRepo({ budgets: { workerPrompt: { enabled: true, maxTurns: 4 } } });
  const reqs: AgentRequest[] = [];
  const run = await runGoal({ store, runner: planned([task('T1')], { onReq: (r) => reqs.push(r), fake: { failFirstAttemptOf: ['T1'] } }), goal: 'g' });
  // 3 turns used by attempt 1 of 4 allowed: attempt 2 is still allowed, with 1 turn left.
  assert.equal(workers(reqs).length, 2);
  assert.equal(workers(reqs)[1].maxTurns, 1);
  assert.match(workers(reqs)[1].prompt, /1 turns remaining of 4/);
  assert.equal(run.tasks[0].status, 'merged');
});

test('best-of-n: no verifier means exactly one sample; with a test command n samples run and tests select', async () => {
  const none = tempRepo({ bestOfN: { enabled: true, n: 3 }, testCommand: null });
  const r1: AgentRequest[] = [];
  const run1 = await runGoal({ store: none, runner: planned([task('T1')], { onReq: (r) => r1.push(r) }), goal: 'g' });
  assert.equal(run1.status, 'done');
  assert.equal(workers(r1).length, 1);
  assert.ok(none.events(run1.id).some((e) => /best-of-n skipped/.test(e.msg)));

  const store = tempRepo({ bestOfN: { enabled: true, n: 2 }, testCommand: 'test -f fake/GOOD.txt' });
  const reqs: AgentRequest[] = [];
  // Only the second sample (variant s2) writes the file the test command needs.
  const after = async (req: AgentRequest) => {
    if (req.role === 'worker' && req.meta?.variant === 's2') {
      mkdirSync(`${req.cwd}/fake`, { recursive: true });
      writeFileSync(`${req.cwd}/fake/GOOD.txt`, 'ok\n');
    }
  };
  const run = await runGoal({ store, runner: planned([task('T1')], { onReq: (r) => reqs.push(r), after }), goal: 'g' });
  assert.equal(workers(reqs).length, 2);
  assert.equal(run.status, 'done');
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
  assert.match(files, /fake\/GOOD\.txt/);
  assert.ok(store.events(run.id).some((e) => /sample 2 selected/.test(e.msg)));
  assert.equal(execFileSync('git', ['branch', '--list', '*-s2'], { cwd: store.root, encoding: 'utf8' }).trim(), '', 'sample branches are cleaned up');
});

test('best-of-n off: one sample even with a test command', async () => {
  const store = tempRepo({ testCommand: 'true' });
  const reqs: AgentRequest[] = [];
  await runGoal({ store, runner: planned([task('T1')], { onReq: (r) => reqs.push(r) }), goal: 'g' });
  assert.equal(workers(reqs).length, 1);
});

test('cache discipline: siblings share tools and prompt prefix, warm-first delays the fan-out, cache share is reported', async () => {
  const store = tempRepo({ concurrency: 2, allowedTools: ['Write', 'Bash', 'Edit'], cache: { discipline: { enabled: true, warmFirst: true } } });
  const reqs: AgentRequest[] = [];
  const order: string[] = [];
  const onReq = (r: AgentRequest) => {
    if (r.role !== 'worker') return;
    reqs.push(r);
    const id = r.meta!.task!;
    order.push(`start:${id}`);
    const orig = r.onAction;
    let first = true;
    r.onAction = (a) => {
      if (first) order.push(`action:${id}`);
      first = false;
      orig?.(a);
    };
  };
  const run = await runGoal({ store, runner: planned([task('T1'), task('T2')], { onReq, fake: { stepMs: 5 } }), goal: 'g' });
  assert.equal(run.status, 'done');
  const [a, b] = workers(reqs);
  assert.deepEqual(a.allowedTools, ['Bash', 'Edit', 'Write']);
  assert.deepEqual(a.allowedTools, b.allowedTools);
  assert.equal(a.system, b.system);
  const prefix = (p: string) => p.slice(0, p.indexOf('YOUR TASK'));
  assert.ok(prefix(a.prompt).length > 0);
  assert.equal(prefix(a.prompt), prefix(b.prompt));
  assert.ok(order.indexOf('start:T2') > order.indexOf('action:T1'), order.join(','));
  assert.equal(typeof run.cacheReadShare, 'number');
  assert.equal(store.events(run.id).find((e) => e.kind === 'run.end')!.data?.cacheReadShare, run.cacheReadShare);
});

test('cache discipline off: tool order and parallel start are untouched', async () => {
  const store = tempRepo({ concurrency: 2, allowedTools: ['Write', 'Bash', 'Edit'] });
  const reqs: AgentRequest[] = [];
  const starts: string[] = [];
  const onReq = (r: AgentRequest) => {
    if (r.role === 'worker') { reqs.push(r); starts.push(`start:${r.meta!.task}`); r.onAction = undefined; }
  };
  await runGoal({ store, runner: planned([task('T1'), task('T2')], { onReq, fake: { stepMs: 5 } }), goal: 'g' });
  assert.deepEqual(workers(reqs)[0].allowedTools, ['Write', 'Bash', 'Edit']);
  assert.deepEqual(starts, ['start:T1', 'start:T2']);
});

test('provider: default is the Claude adapter around the injected runner; unknown names are rejected', async () => {
  const store = tempRepo();
  const seen: string[] = [];
  const run = await runGoal({ store, runner: planned([task('T1')], { onReq: (r) => seen.push(r.role) }), goal: 'g' });
  assert.equal(run.status, 'done');
  assert.ok(seen.includes('planner') && seen.includes('worker') && seen.includes('judge'));
  const bad = tempRepo({ provider: 'nope' });
  await assert.rejects(() => runGoal({ store: bad, runner: planned([task('T1')]), goal: 'g' }), /unknown model provider "nope"/);
});
