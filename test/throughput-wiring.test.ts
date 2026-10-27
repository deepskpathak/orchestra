import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { AgentRequest, AgentResult, Runner } from '../src/agent.ts';
import { approveTask } from '../src/approve.ts';
import { runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';
import { tempRepo } from './helpers.ts';

// Wrap the fake runner with a custom plan; records running intervals of workers.
function planned(tasks: any[], intervals: Record<string, [number, number]> = {}, stepMs = 15): Runner {
  const inner = fakeRunner({ stepMs, failFirstAttemptOf: [] });
  return async (req: AgentRequest): Promise<AgentResult> => {
    if (req.role === 'planner') {
      return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { tasks, scenarios: [] } };
    }
    if (req.role !== 'worker') return inner(req);
    const id = req.meta?.task ?? '';
    const start = Date.now();
    const res = await inner(req);
    intervals[id] = [start, Date.now()];
    return res;
  };
}
const t = (id: string, files?: string[]) => ({ id, title: id, description: id, acceptance: [], deps: [], ...(files ? { footprint: { files } } : {}) });

test('footprint scheduling: overlapping tasks never run together, disjoint ones may', async () => {
  const store = tempRepo({ concurrency: 3, throughput: { footprintScheduling: true, batchMerge: { enabled: false, maxBatch: 4 } } });
  const iv: Record<string, [number, number]> = {};
  const run = await runGoal({ store, runner: planned([t('T1', ['a.txt']), t('T2', ['a.txt']), t('T3', ['c.txt'])], iv), goal: 'g' });
  assert.equal(run.status, 'done');
  const overlap = (x: string, y: string) => iv[x][0] < iv[y][1] && iv[y][0] < iv[x][1];
  assert.equal(overlap('T1', 'T2'), false);
  assert.equal(overlap('T1', 'T3') || overlap('T2', 'T3'), true);
  assert.equal(typeof run.conflictRate, 'number');
});

// Each worker appends one line to a committed CHANGELOG.md, so two parallel tasks touch the same hunk.
async function changelogRun(throughput: Record<string, unknown>) {
  const store = tempRepo({ concurrency: 2, throughput: { footprintScheduling: true, batchMerge: { enabled: false, maxBatch: 4 }, ...throughput } as never });
  const { appendFileSync, writeFileSync } = await import('node:fs');
  writeFileSync(`${store.root}/CHANGELOG.md`, '# Changelog\n\n## Unreleased\n');
  execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: store.root });
  execFileSync('git', ['commit', '-qm', 'changelog'], { cwd: store.root });
  const iv: Record<string, [number, number]> = {};
  const inner = planned([t('T1', ['a.txt', 'CHANGELOG.md']), t('T2', ['b.txt', 'CHANGELOG.md'])], iv);
  const runner: Runner = async (req) => {
    if (req.role === 'worker') appendFileSync(`${req.cwd}/CHANGELOG.md`, `- ${req.meta?.task}\n`);
    return inner(req);
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  const changelog = execFileSync('git', ['show', `${run.integrationBranch}:CHANGELOG.md`], { cwd: store.root, encoding: 'utf8' });
  const overlap = iv.T1[0] < iv.T2[1] && iv.T2[0] < iv.T1[1];
  return { run, changelog, overlap };
}

test('shared files: tasks that share only CHANGELOG.md run in parallel and both appends merge', async () => {
  const { run, changelog, overlap } = await changelogRun({});
  assert.equal(run.status, 'done');
  assert.equal(overlap, true, 'CHANGELOG.md alone must not serialize the tasks');
  assert.match(changelog, /^- T1$/m);
  assert.match(changelog, /^- T2$/m);
  assert.equal(run.conflictRate, 0, 'the union driver merges both appends without a conflict');
});

test('git merge: two appends to CHANGELOG.md conflict by default and merge with the union driver', async () => {
  const g = await import('../src/git.ts');
  const { appendFileSync, writeFileSync, readFileSync } = await import('node:fs');
  const store = tempRepo();
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: store.root, encoding: 'utf8' });
  writeFileSync(`${store.root}/CHANGELOG.md`, '# Changelog\n');
  sh('add', '-A');
  sh('commit', '-qm', 'base');
  for (const b of ['x', 'y']) {
    sh('checkout', '-qb', b, 'main');
    appendFileSync(`${store.root}/CHANGELOG.md`, `- ${b}\n`);
    sh('commit', '-qam', b);
  }
  sh('checkout', '-q', 'x');
  assert.equal(g.merge(store.root, 'y', 'm').ok, false, 'plain merge conflicts');
  assert.equal(sh('status', '--porcelain').trim(), '', 'a failed merge is aborted');
  assert.equal(g.merge(store.root, 'y', 'm', ['CHANGELOG.md']).ok, true);
  assert.match(readFileSync(`${store.root}/CHANGELOG.md`, 'utf8'), /- x\n- y\n|- y\n- x\n/);
  assert.equal(sh('check-attr', 'merge', 'CHANGELOG.md').trim(), 'CHANGELOG.md: merge: unspecified', 'the repo attributes are not edited');
});

test('shared files: an empty sharedFiles list keeps CHANGELOG.md as overlap', async () => {
  const { run, changelog, overlap } = await changelogRun({ sharedFiles: [] });
  assert.equal(run.status, 'done');
  assert.equal(overlap, false);
  assert.match(changelog, /^- T1$/m);
  assert.match(changelog, /^- T2$/m);
});

test('conflict rate is recorded with all features off, and the run.end event carries it', async () => {
  const store = tempRepo();
  const run = await runGoal({ store, runner: fakeRunner(), goal: 'g' });
  assert.equal(run.conflictRate, 0);
  const end = store.events(run.id).find((e) => e.kind === 'run.end')!;
  assert.equal(end.data?.conflictRate, 0);
  assert.equal(run.requestedBy !== undefined, true);
});

test('footprint scheduling appends a decision log to dependents', async () => {
  const store = tempRepo({ concurrency: 2, throughput: { footprintScheduling: true, batchMerge: { enabled: false, maxBatch: 4 } } });
  const prompts: Record<string, string> = {};
  const inner = planned([t('T1', ['a.txt']), { ...t('T2', ['b.txt']), deps: ['T1'] }], {}, 0);
  const runner: Runner = async (req) => {
    if (req.role === 'worker') prompts[req.meta?.task ?? ''] = req.prompt;
    return inner(req);
  };
  await runGoal({ store, runner, goal: 'g' });
  assert.match(prompts.T2, /Decisions from merged dependencies/);
  assert.doesNotMatch(prompts.T1, /Decisions from merged dependencies/);
});

test('batch merge: a task that breaks post-merge tests goes to repair, the others land, fewer test runs', async () => {
  async function scenario(batch: boolean) {
    const store = tempRepo({ concurrency: 3, throughput: { footprintScheduling: true, batchMerge: { enabled: batch, maxBatch: 4 } } });
    const counter = `${store.root}/../tests-${batch ? 'b' : 'p'}-${Date.now()}.log`;
    // Fails only on the first sight of fake/T3.txt (T3's first attempt is poisoned via its content).
    store.writeJson('config.json', { ...store.config(), testCommand: `echo run >> ${counter}; ! grep -rq POISON fake 2>/dev/null` });
    const inner = planned([t('T1', ['fake/T1.txt']), t('T2', ['fake/T2.txt']), t('T3', ['fake/T3.txt'])], {}, 5);
    const runner: Runner = async (req) => {
      const res = await inner(req);
      // Poison T3's first worker attempt.
      if (req.role === 'worker' && req.meta?.task === 'T3' && (req.meta?.attempt ?? 1) === 1) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(`${req.cwd}/fake/T3.txt`, 'POISON\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    const runs = execFileSync('sh', ['-c', `wc -l < ${counter}`], { encoding: 'utf8' }).trim();
    return { run, runs: Number(runs) };
  }
  const per = await scenario(false);
  const bat = await scenario(true);
  assert.equal(per.run.status, 'done');
  assert.equal(bat.run.status, 'done');
  const t3 = bat.run.tasks.find((x) => x.id === 'T3')!;
  assert.equal(t3.attempts, 2, 'the poisoned task is repaired');
  assert.equal(bat.run.tasks.find((x) => x.id === 'T1')!.attempts, 1);
  assert.equal(bat.run.tasks.find((x) => x.id === 'T2')!.attempts, 1);
  assert.ok(bat.runs < per.runs, `batched ${bat.runs} < per-task ${per.runs}`);
  assert.equal(typeof bat.run.tasks[0].mergeWaitMs, 'number');
});

test('risk tiers: infra task awaits approval; requester and agents cannot approve, another human can', async () => {
  const prev = process.env.ORCHESTRA_REQUESTER;
  process.env.ORCHESTRA_REQUESTER = 'alice';
  try {
    const store = tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } } });
    const inner = planned([t('T1', ['infra/main.tf'])], {}, 0);
    const runner: Runner = async (req) => {
      const res = await inner(req);
      if (req.role === 'worker') {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${req.cwd}/infra`, { recursive: true });
        writeFileSync(`${req.cwd}/infra/main.tf`, 'resource {}\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    assert.equal(run.requestedBy, 'alice');
    assert.equal(run.tasks[0].status, 'awaiting_approval');
    assert.equal(run.tasks[0].risk?.tier, 'high');
    assert.ok(store.events(run.id).some((e) => e.kind === 'task.approval'));

    await assert.rejects(() => approveTask(store, run.id, 'T1', 'alice'), /requester/);
    await assert.rejects(() => approveTask(store, run.id, 'T1', 'ALICE '), /requester/);
    await assert.rejects(() => approveTask(store, run.id, 'T1', 'judge'), /agent/);
    await assert.rejects(() => approveTask(store, run.id, 'T1', 'worker'), /agent/);
    assert.equal(store.loadRun(run.id)!.tasks[0].status, 'awaiting_approval');

    const done = await approveTask(store, run.id, 'T1', 'bob');
    assert.equal(done.tasks[0].status, 'merged');
    assert.equal(done.status, 'done');
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
    assert.match(files, /infra\/main\.tf/);
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_REQUESTER;
    else process.env.ORCHESTRA_REQUESTER = prev;
  }
});

test('config: partial throughput and oversight blocks merge with defaults', () => {
  const store = tempRepo();
  store.writeJson('config.json', { throughput: { batchMerge: { enabled: true } }, oversight: { riskTiers: { enabled: true } } });
  const c = store.config();
  assert.equal(c.throughput!.footprintScheduling, false);
  assert.equal(c.throughput!.batchMerge.maxBatch, 4);
  assert.equal(c.throughput!.batchMerge.enabled, true);
  assert.equal(c.oversight!.riskTiers.enabled, true);
  assert.equal(c.oversight!.riskTiers.largeDiffLines, 400);
});

test('batch merge: an interaction between two individually good halves never lands untested', async () => {
  const store = tempRepo({ concurrency: 4, throughput: { footprintScheduling: true, batchMerge: { enabled: true, maxBatch: 4 } } });
  // Suite fails only when T1 and T3 are both on the integration branch.
  store.writeJson('config.json', { ...store.config(), testCommand: '! (test -f fake/T1.txt && test -f fake/T3.txt)' });
  const ids = ['T1', 'T2', 'T3', 'T4'];
  const run = await runGoal({ store, runner: planned(ids.map((id) => t(id, [`fake/${id}.txt`])), {}, 5), goal: 'g' });
  const merged = (id: string) => run.tasks.find((x) => x.id === id)!.status === 'merged';
  assert.equal(merged('T1') && merged('T3'), false, 'T1 and T3 must not both land');
  assert.equal(merged('T2'), true);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
  assert.equal(/fake\/T1\.txt/.test(files) && /fake\/T3\.txt/.test(files), false);
});

test('orchestra approve (CLI): requester, agent names and missing --by are refused; another human merges', async () => {
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { PACKAGE_ROOT } = await import('../src/harness.ts');
  const prev = process.env.ORCHESTRA_REQUESTER;
  process.env.ORCHESTRA_REQUESTER = 'alice';
  try {
    const store = tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } } });
    const inner = planned([t('T1', ['infra/main.tf'])], {}, 0);
    const runner: Runner = async (req) => {
      const res = await inner(req);
      if (req.role === 'worker') {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${req.cwd}/infra`, { recursive: true });
        writeFileSync(`${req.cwd}/infra/main.tf`, 'resource {}\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
    const approve = (...a: string[]) => spawnSync(process.execPath, [cli, 'approve', run.id, 'T1', ...a], { cwd: store.root, encoding: 'utf8', timeout: 60000 });
    for (const who of ['alice', 'worker', 'judge']) {
      const r = approve('--by', who);
      assert.equal(r.status, 1, `${who}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /approval refused/);
    }
    const noBy = approve();
    assert.equal(noBy.status, 1);
    assert.match(noBy.stderr, /usage: orchestra approve/);
    assert.equal(store.loadRun(run.id)!.tasks[0].status, 'awaiting_approval');
    const ok = approve('--by', 'bob');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /approved by bob/);
    assert.equal(store.loadRun(run.id)!.tasks[0].status, 'merged');
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_REQUESTER;
    else process.env.ORCHESTRA_REQUESTER = prev;
  }
});

test('approve: failing post-merge tests restore the integration branch and keep the task held', async () => {
  const prev = process.env.ORCHESTRA_REQUESTER;
  process.env.ORCHESTRA_REQUESTER = 'alice';
  try {
    const store = tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } } });
    const inner = planned([t('T1', ['infra/main.tf'])], {}, 0);
    const runner: Runner = async (req) => {
      const res = await inner(req);
      if (req.role === 'worker') {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${req.cwd}/infra`, { recursive: true });
        writeFileSync(`${req.cwd}/infra/main.tf`, 'resource {}\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    const tip = () => execFileSync('git', ['rev-parse', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' }).trim();
    const before = tip();
    store.writeJson('config.json', { ...store.config(), testCommand: '! test -f infra/main.tf' });
    await assert.rejects(() => approveTask(store, run.id, 'T1', 'bob'), /post-merge tests fail/);
    assert.equal(tip(), before, 'the failing merge is not left on the integration branch');
    assert.equal(store.loadRun(run.id)!.tasks[0].status, 'awaiting_approval');
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_REQUESTER;
    else process.env.ORCHESTRA_REQUESTER = prev;
  }
});

test('batch merge: tasks that start while a batch is under test branch from the last known-good commit', async () => {
  // T2 lands first (batch of one). T1 then lands on top of it and breaks the suite, and its post-merge test run is
  // slow. T3 depends on T2, so it starts while T1's rejected merge sits on the integration worktree.
  const store = tempRepo({ concurrency: 3, throughput: { footprintScheduling: false, batchMerge: { enabled: true, maxBatch: 1 } } });
  store.writeJson('config.json', { ...store.config(), testCommand: 'sleep 0.4; ! (test -f fake/T1.txt && test -f fake/T2.txt)' });
  const seen: Record<string, boolean> = {};
  const inner = planned([t('T1'), t('T2'), { ...t('T3'), deps: ['T2'] }], {}, 0);
  const runner: Runner = async (req) => {
    if (req.role === 'worker') {
      const { existsSync } = await import('node:fs');
      seen[req.meta?.task ?? ''] ??= existsSync(`${req.cwd}/fake/T1.txt`);
      // T1 reaches the merge queue after T2, so its batch is queued behind T2's.
      if (req.meta?.task === 'T1') await new Promise((r) => setTimeout(r, 250));
    }
    return inner(req);
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.tasks.find((x) => x.id === 'T2')!.status, 'merged');
  assert.equal(seen.T3, false, 'T3 must not inherit the rejected T1 merge');
  assert.equal(run.tasks.find((x) => x.id === 'T3')!.status, 'merged');
});

test('risk tiers: a run holding only an approval-gated task is awaiting_approval, not failed, and approval finalises it', async () => {
  const prev = process.env.ORCHESTRA_REQUESTER;
  process.env.ORCHESTRA_REQUESTER = 'alice';
  try {
    const store = tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } } });
    const inner = planned([t('T1'), t('T2', ['infra/main.tf']), { ...t('T3'), deps: ['T2'] }], {}, 0);
    let librarianCalls = 0;
    const runner: Runner = async (req) => {
      if (req.role === 'librarian') librarianCalls++;
      const res = await inner(req);
      if (req.role === 'worker' && req.meta?.task === 'T2') {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${req.cwd}/infra`, { recursive: true });
        writeFileSync(`${req.cwd}/infra/main.tf`, 'resource {}\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    assert.equal(run.status, 'awaiting_approval');
    assert.equal(run.error, undefined);
    assert.equal(run.satisfaction, undefined, 'satisfaction waits for the held task');
    assert.equal(librarianCalls, 0, 'learning waits for approval');
    assert.deepEqual(run.tasks.map((x) => x.status), ['merged', 'awaiting_approval', 'blocked']);

    const after = await approveTask(store, run.id, 'T2', 'bob');
    // T3 depended on the held task and never ran, so the run cannot be done; it says so instead of looking like a conductor failure.
    assert.equal(after.status, 'failed');
    assert.match(after.error!, /T3 blocked behind a task that was held for approval/);
    assert.equal(typeof after.satisfaction, 'number');
    assert.ok(after.satisfaction! > 0);
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_REQUESTER;
    else process.env.ORCHESTRA_REQUESTER = prev;
  }
});

test('risk tiers: approving the only unmerged task of a held run marks it done with satisfaction', async () => {
  const prev = process.env.ORCHESTRA_REQUESTER;
  process.env.ORCHESTRA_REQUESTER = 'alice';
  try {
    const store = tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } } });
    const inner = planned([t('T1'), t('T2', ['infra/main.tf'])], {}, 0);
    const runner: Runner = async (req) => {
      const res = await inner(req);
      if (req.role === 'worker' && req.meta?.task === 'T2') {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${req.cwd}/infra`, { recursive: true });
        writeFileSync(`${req.cwd}/infra/main.tf`, 'resource {}\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    assert.equal(run.status, 'awaiting_approval');
    const done = await approveTask(store, run.id, 'T2', 'bob');
    assert.equal(done.status, 'done');
    assert.ok(done.satisfaction! > 0);
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_REQUESTER;
    else process.env.ORCHESTRA_REQUESTER = prev;
  }
});

test('approve: with no recorded requester the approval warns that four-eyes is not enforced', async () => {
  const prev = process.env.ORCHESTRA_REQUESTER;
  delete process.env.ORCHESTRA_REQUESTER;
  const prevCfg = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user.name from the developer's global config
  try {
    const store = tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } } });
    const inner = planned([t('T1', ['infra/main.tf'])], {}, 0);
    const runner: Runner = async (req) => {
      const res = await inner(req);
      if (req.role === 'worker') {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${req.cwd}/infra`, { recursive: true });
        writeFileSync(`${req.cwd}/infra/main.tf`, 'resource {}\n');
      }
      return res;
    };
    const run = await runGoal({ store, runner, goal: 'g' });
    assert.equal(run.requestedBy, 'unknown');
    const warnings: string[] = [];
    const done = await approveTask(store, run.id, 'T1', 'bob', (m) => warnings.push(m));
    assert.equal(done.tasks[0].status, 'merged');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /four-eyes is NOT enforced/);
    assert.ok(store.events(run.id).some((e) => /four-eyes is NOT enforced/.test(e.msg)));
  } finally {
    if (prev !== undefined) process.env.ORCHESTRA_REQUESTER = prev;
    if (prevCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevCfg;
  }
});

test('batch merge: the integration HEAD after a clean batch is the commit that was tested', async () => {
  const store = tempRepo({ concurrency: 3, throughput: { footprintScheduling: true, batchMerge: { enabled: true, maxBatch: 4 } } });
  const log = `${store.root}/../tested-heads-${Date.now()}.log`;
  // Record HEAD only for runs in the integration worktree (the judge also runs the suite in task worktrees).
  store.writeJson('config.json', { ...store.config(), testCommand: `case "$PWD" in *_integration) git rev-parse HEAD >> ${log};; esac; true` });
  const run = await runGoal({ store, runner: planned(['T1', 'T2', 'T3'].map((id) => t(id, [`fake/${id}.txt`])), {}, 5), goal: 'g' });
  assert.equal(run.status, 'done');
  const { readFileSync } = await import('node:fs');
  const tested = readFileSync(log, 'utf8').trim().split('\n');
  const tip = execFileSync('git', ['rev-parse', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' }).trim();
  assert.equal(tested[tested.length - 1], tip, 'the final integration commit was tested, not rebuilt afterwards');
});

test('batch merge: tasks dropped by the union check get the failing output in their repair note', async () => {
  const store = tempRepo({ concurrency: 4, throughput: { footprintScheduling: true, batchMerge: { enabled: true, maxBatch: 4 } } });
  store.writeJson('config.json', { ...store.config(), testCommand: 'if test -f fake/T1.txt && test -f fake/T3.txt; then echo UNION-BROKEN; exit 1; fi' });
  const ids = ['T1', 'T2', 'T3', 'T4'];
  const run = await runGoal({ store, runner: planned(ids.map((id) => t(id, [`fake/${id}.txt`])), {}, 5), goal: 'g' });
  const issues = store.events(run.id).filter((e) => e.kind === 'task.repair').map((e) => ({ task: e.task, text: ((e.data as any)?.issues ?? []).join('\n') }));
  const t3 = issues.filter((i) => i.task === 'T3');
  assert.ok(t3.length > 0, 'T3 is sent to repair');
  for (const i of t3) assert.match(i.text, /UNION-BROKEN/, 'the note carries the failing output, not an empty tail');
});

test('decision log has its own key: on without footprint scheduling, off with it, and follows it when unset', async () => {
  async function promptsFor(throughput: any): Promise<Record<string, string>> {
    const store = tempRepo({ concurrency: 2, throughput });
    const prompts: Record<string, string> = {};
    const inner = planned([t('T1', ['a.txt']), { ...t('T2', ['b.txt']), deps: ['T1'] }], {}, 0);
    const runner: Runner = async (req) => {
      if (req.role === 'worker') prompts[req.meta?.task ?? ''] = req.prompt;
      return inner(req);
    };
    await runGoal({ store, runner, goal: 'g' });
    return prompts;
  }
  const batch = { enabled: false, maxBatch: 4 };
  assert.match((await promptsFor({ footprintScheduling: false, decisionLog: true, batchMerge: batch })).T2, /Decisions from merged dependencies/);
  assert.doesNotMatch((await promptsFor({ footprintScheduling: true, decisionLog: false, batchMerge: batch })).T2, /Decisions from merged dependencies/);
  assert.match((await promptsFor({ footprintScheduling: true, batchMerge: batch })).T2, /Decisions from merged dependencies/);
  assert.doesNotMatch((await promptsFor({ footprintScheduling: false, batchMerge: batch })).T2, /Decisions from merged dependencies/);
});

test('per-call paths (worker caps, budgets) use the config snapshot taken when the run starts', async () => {
  const store = tempRepo({ budgets: { workerPrompt: { enabled: true, maxTurns: 50 } } });
  const turnCaps: (number | undefined)[] = [];
  const inner = fakeRunner({ stepMs: 0, failFirstAttemptOf: ['T1'] });
  const plan = planned([t('T1')], {}, 0);
  const runner: Runner = async (req) => {
    if (req.role === 'worker') {
      turnCaps.push(req.maxTurns);
      // Editing the file mid-run must not change what the hot paths see; that is what the snapshot buys.
      store.writeJson('config.json', { ...store.config(), budgets: { workerPrompt: { enabled: true, maxTurns: 1 } } });
    }
    return req.role === 'planner' ? plan(req) : inner(req);
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.tasks[0].attempts, 2);
  assert.equal(turnCaps.length, 2);
  assert.ok(turnCaps[1]! > 1, `second attempt cap ${turnCaps[1]}`);
});
