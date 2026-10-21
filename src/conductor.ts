// The conductor: deterministic code that coordinates LLM agents.
// plan -> parallel workers in worktrees -> tests + judge -> repair or merge queue -> learn.
// Planners never code, workers never judge, judges never edit (role separation).

import { join } from 'node:path';
import { extractJson, type AgentRequest, type AgentResult, type Runner } from './agent.ts';
import * as g from './git.ts';
import { loadHarness, type Harness } from './harness.ts';
import { formatLearnings, readLearnings, writeLearnings, type Lesson } from './learnings.ts';
import { newRunId, type Store } from './store.ts';
import type { ActiveAgent, OrchestraEvent, Role, Run, Scenario, Task, Verdict } from './types.ts';

export interface ConductorOptions {
  store: Store;
  runner: Runner;
  goal: string;
  harnessVersion?: string;
  baseRef?: string; // eval runs pin the starting commit
  kind?: 'goal' | 'eval';
  onUpdate?: (run: Run) => void;
}

// ---------- prompt builders ----------
// Sections run from most stable to most volatile so the shared `prefix` is byte-identical across
// tasks and attempts (prompt-cache friendly). Never put timestamps, attempt numbers or task
// statuses in a prefix.

export interface BuiltPrompt {
  prefix: string;
  body: string;
}

export const joinPrompt = (p: BuiltPrompt): string => [p.prefix, p.body].filter(Boolean).join('\n\n');

const bullets = (items: string[]): string => items.map((a) => `- ${a}`).join('\n');

export function plannerPrompt(i: { goal: string; files: string[]; testCommand?: string; learnings: string }): BuiltPrompt {
  return {
    prefix: [
      `LEARNINGS:\n${i.learnings}`,
      `REPOSITORY FILES (first ${i.files.length}):\n${i.files.join('\n')}`,
      `TEST COMMAND: ${i.testCommand ?? '(none configured)'}`,
      `GOAL:\n${i.goal}`,
    ].join('\n\n'),
    body: 'Produce the task graph and hidden scenarios.',
  };
}

export function workerPrompt(i: { goal: string; learnings: string; testCommand?: string; task: Task; others: string[] }): BuiltPrompt {
  const { task } = i;
  return {
    prefix: [
      `LEARNINGS:\n${i.learnings}`,
      `TEST COMMAND: ${i.testCommand ?? '(none configured; run relevant tests you find)'}`,
      `OVERALL GOAL (context only):\n${i.goal}`,
    ].join('\n\n'),
    body: [
      `YOUR TASK ${task.id}: ${task.title}\n${task.description}`,
      `ACCEPTANCE CRITERIA:\n${bullets(task.acceptance)}`,
      `OTHER TASKS (owned by other workers, do not do them):\n${i.others.join('\n') || '(none)'}`,
      task.notes.length ? `REPAIR NOTES (previous attempt was rejected, fix all of these):\n${bullets(task.notes)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

export function judgePrompt(i: {
  task: Task;
  scenarios: Scenario[];
  workerText: string;
  testCommand?: string;
  tests: { ok: boolean; tail: string } | null;
  diff: string;
}): BuiltPrompt {
  const { task, tests } = i;
  return {
    prefix: `HIDDEN SCENARIOS for the whole goal (judge only the parts this task is responsible for):\n${i.scenarios
      .map((s) => `- ${s.id}: GIVEN ${s.given} WHEN ${s.when} THEN ${s.then}`)
      .join('\n') || '(none)'}`,
    body: [
      `TASK ${task.id}: ${task.title}\n${task.description}`,
      `ACCEPTANCE CRITERIA:\n${bullets(task.acceptance)}`,
      `WORKER SUMMARY (unverified):\n${i.workerText.slice(0, 3000)}`,
      tests ? `TEST RESULT (${i.testCommand}): ${tests.ok ? 'PASSED' : 'FAILED'}\n${tests.tail}` : 'TEST RESULT: no test command configured',
      `DIFF vs base:\n${i.diff}`,
    ].join('\n\n'),
  };
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          deps: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'description', 'acceptance', 'deps'],
      },
    },
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, given: { type: 'string' }, when: { type: 'string' }, then: { type: 'string' } },
        required: ['id', 'given', 'when', 'then'],
      },
    },
  },
  required: ['tasks', 'scenarios'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'score', 'summary', 'issues'],
};

const LESSONS_SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        properties: { role: { type: 'string', enum: ['planner', 'worker', 'judge'] }, lesson: { type: 'string' } },
        required: ['role', 'lesson'],
      },
    },
  },
  required: ['lessons'],
};

const TIMEOUT_MS: Record<Role, number> = {
  planner: 15 * 60_000,
  worker: 30 * 60_000,
  judge: 15 * 60_000,
  librarian: 10 * 60_000,
  evolver: 15 * 60_000,
};

export class Conductor {
  readonly run: Run;
  private readonly store: Store;
  private readonly runner: Runner;
  private readonly harness: Harness;
  private readonly onUpdate?: (run: Run) => void;
  private scenarios: Scenario[] = [];
  private integration!: { path: string; branch: string; base: string };
  private mergeChain: Promise<unknown> = Promise.resolve();
  private readonly wtRoot: string;

  constructor(opts: ConductorOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.harness = loadHarness(opts.store, opts.harnessVersion);
    this.onUpdate = opts.onUpdate;
    this.wtRoot = opts.store.path('worktrees');
    const id = (opts.kind === 'eval' ? 'e' : '') + newRunId();
    this.run = {
      id,
      goal: opts.goal,
      harness: this.harness.version,
      kind: opts.kind ?? 'goal',
      status: 'planning',
      startedAt: Date.now(),
      tasks: [],
      costUsd: 0,
      active: [],
      baseRef: opts.baseRef,
    };
  }

  // ---------- public ----------

  async execute(): Promise<Run> {
    const { run, store } = this;
    try {
      g.assertRepo(store.root);
      g.excludeOrchestra(store.root);
      this.integration = g.createIntegration(store.root, this.wtRoot, run.id, run.baseRef);
      run.integrationBranch = this.integration.branch;
      run.baseRef = this.integration.base;
      this.emit('run.start', `Run started: ${run.goal}`, { harness: run.harness });
      this.save();

      await this.plan();
      run.status = 'running';
      this.save();
      await this.schedule();

      const merged = run.tasks.filter((t) => t.status === 'merged');
      const meanScore = merged.length ? merged.reduce((s, t) => s + (t.verdict?.score ?? 0), 0) / merged.length : 0;
      run.satisfaction = round(meanScore * (merged.length / Math.max(1, run.tasks.length)));

      if (run.kind === 'goal') {
        run.status = 'compounding';
        this.save();
        await this.learn();
      }
      run.status = merged.length === run.tasks.length ? 'done' : 'failed';
      if (run.status === 'failed' && !run.error) run.error = `${run.tasks.length - merged.length} of ${run.tasks.length} tasks did not land`;
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;
      this.emit('log', `Run aborted: ${run.error}`);
    } finally {
      run.endedAt = Date.now();
      run.active = [];
      this.cleanup();
      this.emit('run.end', `Run ${run.status}. satisfaction ${run.satisfaction ?? 0}, cost $${run.costUsd.toFixed(2)}`, {
        satisfaction: run.satisfaction,
        branch: run.integrationBranch,
      });
      this.save();
    }
    return run;
  }

  // ---------- phases ----------

  private async plan(): Promise<void> {
    const { run, store, harness } = this;
    const learnings = readLearnings(store);
    const cfg = store.config();
    const files = g.trackedFiles(this.integration.path);
    const built = plannerPrompt({
      goal: run.goal,
      files,
      testCommand: cfg.testCommand,
      learnings: formatLearnings(learnings, 'planner'),
    });
    const prompt = joinPrompt(built);

    const res = await this.call('planner', undefined, 1, {
      prompt,
      cwd: this.integration.path,
      schema: PLAN_SCHEMA,
      tools: ['Read', 'Grep', 'Glob'],
    });
    const out = extractJson(res) as { tasks?: any[]; scenarios?: Scenario[] } | undefined;
    if (!res.ok || !out?.tasks?.length) throw new Error(`Planner failed: ${res.error ?? 'no tasks returned'}`);

    run.tasks = normalizeTasks(out.tasks);
    this.scenarios = out.scenarios ?? [];
    // Holdout: only the judge ever receives these. .orchestra is outside every worktree.
    store.writeJson(`holdout/${run.id}.json`, this.scenarios);
    this.emit('plan', `Planned ${run.tasks.length} tasks, ${this.scenarios.length} hidden scenarios`, {
      tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, deps: t.deps })),
    });
    this.save();
  }

  private async schedule(): Promise<void> {
    const { run } = this;
    const cfg = this.store.config();
    const inflight = new Map<string, Promise<void>>();

    for (;;) {
      if (run.costUsd >= cfg.runBudgetUsd) {
        for (const t of run.tasks) {
          if (t.status === 'pending' || t.status === 'repair') this.fail(t, `run budget $${cfg.runBudgetUsd} exhausted`);
        }
      }
      const ready = run.tasks.filter(
        (t) => (t.status === 'pending' || t.status === 'repair') && !inflight.has(t.id) && t.deps.every((d) => this.task(d)?.status === 'merged'),
      );
      for (const t of ready.slice(0, Math.max(0, cfg.concurrency - inflight.size))) {
        const p = this.attempt(t)
          .catch((err) => this.fail(t, `internal error: ${(err as Error).message}`))
          .finally(() => inflight.delete(t.id));
        inflight.set(t.id, p);
      }
      if (inflight.size === 0) break;
      await Promise.race(inflight.values());
    }
    // Anything left pending has an unmet dependency chain.
    for (const t of run.tasks) if (t.status === 'pending' || t.status === 'repair') this.block(t, 'dependency never landed');
  }

  // One attempt: worker -> commit -> tests -> judge -> (merge | repair | fail).
  private async attempt(task: Task): Promise<void> {
    const { store, harness } = this;
    const cfg = store.config();
    task.attempts += 1;
    task.status = 'running';
    task.startedAt ??= Date.now();
    const wt = g.createTaskWorktree(store.root, this.wtRoot, this.run.id, task.id, g.head(this.integration.path));
    task.branch = wt.branch;
    task.worktree = wt.path;
    const base = g.mergeBase(wt.path, 'HEAD', this.integration.branch);
    this.emit('task.start', `${task.id} attempt ${task.attempts}: ${task.title}`, undefined, task.id);
    this.save();

    const learnings = readLearnings(store);
    const others = this.run.tasks.filter((t) => t.id !== task.id).map((t) => `- ${t.id} ${t.title} [${t.status}]`);
    const prompt = joinPrompt(
      workerPrompt({
        goal: this.run.goal,
        learnings: formatLearnings(learnings, 'worker'),
        testCommand: cfg.testCommand,
        task,
        others,
      }),
    );

    const work = await this.call('worker', task, task.attempts, {
      prompt,
      cwd: wt.path,
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      permissionMode: cfg.permissionMode,
    });
    g.commitAll(wt.path, `${task.id}: ${task.title} (orchestra attempt ${task.attempts})`);

    // ---- self-evaluation ----
    task.status = 'judging';
    this.save();
    let verdict: Verdict;
    if (!work.ok && !g.hasChangesSince(wt.path, base)) {
      verdict = { pass: false, score: 0, summary: `Worker failed: ${work.error}`, issues: [`Previous attempt crashed: ${work.error}`], testsPassed: null };
    } else if (!g.hasChangesSince(wt.path, base)) {
      verdict = { pass: false, score: 0, summary: 'No changes were committed', issues: ['No code changes were produced. Implement the task.'], testsPassed: null };
    } else {
      verdict = await this.judge(task, wt.path, base, work);
    }
    task.verdict = verdict;
    const label = verdict.judgeError ? 'JUDGE ERROR' : `${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.score.toFixed(2)}`;
    this.emit('task.verdict', `${task.id} ${label}: ${verdict.summary}`, { verdict }, task.id);

    // The worker is not at fault, so do not spend a repair attempt (which would redo it).
    if (verdict.judgeError) {
      this.ledgerOutcome(task, 'judge_error');
      return this.fail(task, `judge failed twice: ${verdict.judgeError}. Raise budgetUsd.judge in the harness config or re-run`);
    }

    // ---- self-correction ----
    if (!verdict.pass) return this.repairOrFail(task, verdict.issues.length ? verdict.issues : [verdict.summary]);

    task.status = 'merging';
    this.save();
    await this.enqueueMerge(task);
  }

  private async judge(task: Task, cwd: string, base: string, work: AgentResult): Promise<Verdict> {
    const cfg = this.store.config();
    const tests = cfg.testCommand ? g.runTests(cwd, cfg.testCommand) : null;
    if (tests) this.emit('log', `${task.id} tests ${tests.ok ? 'passed' : 'FAILED'}`, undefined, task.id);
    const headBefore = g.head(cwd);
    const prompt = joinPrompt(
      judgePrompt({
        task,
        scenarios: this.scenarios,
        workerText: work.text,
        testCommand: cfg.testCommand,
        tests,
        diff: g.diffSince(cwd, base),
      }),
    );

    // A judge crash or budget exhaustion says nothing about the worker: retry the judge alone, once.
    let v: Partial<Verdict> | undefined;
    let error: string | undefined;
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      const res = await this.call('judge', task, task.attempts, {
        prompt,
        cwd,
        schema: VERDICT_SCHEMA,
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        disallowedTools: ['Edit', 'Write', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(rm:*)'],
        permissionMode: 'default',
      });
      // Judges never edit. If one did anyway, discard it.
      g.resetTo(cwd, headBefore);
      v = extractJson(res) as Partial<Verdict> | undefined;
      if (res.ok && v && typeof v.score === 'number') break;
      v = undefined;
      error = res.error ?? 'no verdict';
      if (tryNo === 1) this.emit('log', `${task.id} judge failed (${error}), retrying judge once`, undefined, task.id);
    }
    if (!v || typeof v.score !== 'number') {
      return { pass: false, score: 0, summary: `Judge failed twice: ${error}`, issues: [], testsPassed: tests?.ok ?? null, judgeError: error };
    }
    const testsOk = tests ? tests.ok : null;
    const pass = Boolean(v.pass) && v.score >= this.harness.config.passThreshold && testsOk !== false;
    const issues = [...(v.issues ?? [])];
    if (testsOk === false) issues.unshift(`Test command \`${cfg.testCommand}\` fails. Output tail:\n${tests!.tail.slice(-1200)}`);
    return { pass, score: round(v.score), summary: v.summary ?? '', issues, testsPassed: testsOk };
  }

  // Refinery: merges are serialized; post-merge tests guard the integration branch.
  private enqueueMerge(task: Task): Promise<void> {
    const job = this.mergeChain.then(() => this.mergeOne(task));
    this.mergeChain = job.catch(() => undefined);
    return job;
  }

  private async mergeOne(task: Task): Promise<void> {
    const cfg = this.store.config();
    const ip = this.integration.path;
    const before = g.head(ip);
    const m = g.merge(ip, task.branch!, `Merge ${task.id}: ${task.title}`);
    if (!m.ok) {
      this.ledgerOutcome(task, 'conflict');
      g.resetTo(task.worktree!, before);
      return this.repairOrFail(task, ['Your previous change conflicted with work merged by other tasks. Re-implement the task on top of the latest code.']);
    }
    if (cfg.testCommand) {
      const t = g.runTests(ip, cfg.testCommand);
      if (!t.ok) {
        g.resetTo(ip, before);
        g.resetTo(task.worktree!, before);
        return this.repairOrFail(task, [`After merging with other tasks the test suite fails. Re-implement on the latest code. Output tail:\n${t.tail.slice(-1200)}`]);
      }
    }
    task.status = 'merged';
    task.endedAt = Date.now();
    this.ledgerOutcome(task, 'merged');
    this.emit('task.merged', `${task.id} merged (attempt ${task.attempts})`, undefined, task.id);
    this.save();
  }

  private repairOrFail(task: Task, issues: string[]): void {
    if (task.attempts >= this.harness.config.maxAttempts) {
      this.fail(task, `out of attempts (${task.attempts}). Last issues: ${issues.join(' | ').slice(0, 300)}`);
      return;
    }
    task.notes = issues;
    task.status = 'repair';
    this.emit('task.repair', `${task.id} -> repair: ${issues[0]?.split('\n')[0] ?? ''}`, { issues }, task.id);
    this.save();
  }

  private fail(task: Task, reason: string): void {
    task.status = 'failed';
    task.endedAt = Date.now();
    this.emit('task.failed', `${task.id} failed: ${reason}`, undefined, task.id);
    for (const t of this.run.tasks) if (t.deps.includes(task.id) && (t.status === 'pending' || t.status === 'repair')) this.block(t, `${task.id} failed`);
    this.save();
  }

  private block(task: Task, reason: string): void {
    task.status = 'blocked';
    this.emit('task.failed', `${task.id} blocked: ${reason}`, undefined, task.id);
    for (const t of this.run.tasks) if (t.deps.includes(task.id) && t.status === 'pending') this.block(t, `${task.id} blocked`);
  }

  // Compound step: turn this run's evidence into durable lessons for the next run.
  private async learn(): Promise<void> {
    const { run, store } = this;
    const report = run.tasks
      .map((t) =>
        [
          `${t.id} ${t.title}: ${t.status}, attempts ${t.attempts}, cost $${t.costUsd.toFixed(2)}`,
          t.verdict ? `  final verdict ${t.verdict.score}: ${t.verdict.summary}` : '',
          ...t.notes.map((n) => `  repair note: ${n.split('\n')[0]}`),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
    const events = store
      .events(run.id)
      .filter((e) => e.kind === 'task.repair' || e.kind === 'task.failed')
      .map((e) => `- ${e.msg}`)
      .join('\n');
    const existing = readLearnings(store);
    const res = await this.call('librarian', undefined, 1, {
      prompt: [
        `RUN REPORT\nGoal: ${run.goal}\nSatisfaction: ${run.satisfaction}\nCost: $${run.costUsd.toFixed(2)}\n${report}`,
        `REPAIRS AND FAILURES:\n${events || '(none)'}`,
        `EXISTING LEARNINGS:\n${JSON.stringify(existing, null, 2)}`,
      ].join('\n\n'),
      cwd: this.integration.path,
      schema: LESSONS_SCHEMA,
      tools: [],
    });
    const out = extractJson(res) as { lessons?: Lesson[] } | undefined;
    if (res.ok && Array.isArray(out?.lessons)) {
      writeLearnings(store, out.lessons, run.id);
      this.emit('learn', `Learnings updated: ${out.lessons.length} lessons`, { count: out.lessons.length });
    } else {
      this.emit('log', `Librarian failed: ${res.error ?? 'no lessons'}`);
    }
  }

  // ---------- plumbing ----------

  private async call(role: Role, task: Task | undefined, attempt: number, req: Omit<AgentRequest, 'role' | 'system' | 'model' | 'budgetUsd'>): Promise<AgentResult> {
    const { run, harness } = this;
    const model = harness.config.models[role];
    const agent: ActiveAgent = {
      key: `${role}:${task?.id ?? '-'}:${attempt}`,
      role,
      task: task?.id,
      model,
      startedAt: Date.now(),
      lastAction: 'starting',
      tools: 0,
      costUsd: 0,
    };
    run.active.push(agent);
    this.emit('agent.start', `${role} started${task ? ` on ${task.id}` : ''} (${model})`, undefined, task?.id, role);
    this.save();
    let lastSave = 0;
    const res = await this.runner({
      ...req,
      role,
      model,
      system: harness.prompts[role],
      budgetUsd: harness.config.budgetUsd[role],
      timeoutMs: TIMEOUT_MS[role],
      logFile: this.store.path('runs', run.id, 'logs', `${task?.id ?? 'run'}-${role}-${attempt}.jsonl`),
      meta: { task: task?.id, attempt },
      onAction: (action) => {
        agent.lastAction = action;
        if (!action.startsWith('says:')) agent.tools += 1;
        this.emit('agent.action', action, undefined, task?.id, role);
        if (Date.now() - lastSave > 200) {
          lastSave = Date.now();
          this.save();
        }
      },
    });
    run.active = run.active.filter((a) => a !== agent);
    run.costUsd = round(run.costUsd + res.costUsd, 4);
    if (task) task.costUsd = round(task.costUsd + res.costUsd, 4);
    this.store.ledger({
      t: Date.now(),
      run: run.id,
      kind: run.kind,
      harness: harness.version,
      role,
      task: task?.id,
      attempt,
      model,
      ok: res.ok,
      costUsd: res.costUsd,
      durationMs: res.durationMs,
      turns: res.turns,
    });
    this.emit('agent.end', `${role}${task ? ` ${task.id}` : ''} ${res.ok ? 'finished' : `error: ${res.error}`} ($${res.costUsd.toFixed(2)}, ${Math.round(res.durationMs / 1000)}s)`, undefined, task?.id, role);
    this.save();
    return res;
  }

  private ledgerOutcome(task: Task, outcome: string): void {
    this.store.ledger({
      t: Date.now(),
      run: this.run.id,
      kind: this.run.kind,
      harness: this.harness.version,
      role: 'worker',
      task: task.id,
      attempt: task.attempts,
      model: this.harness.config.models.worker,
      ok: outcome === 'merged',
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      outcome,
      score: task.verdict?.judgeError ? undefined : task.verdict?.score,
    });
  }

  private task(id: string): Task | undefined {
    return this.run.tasks.find((t) => t.id === id);
  }

  private emit(kind: OrchestraEvent['kind'], msg: string, data?: Record<string, unknown>, task?: string, role?: Role): void {
    this.store.event({ t: Date.now(), run: this.run.id, kind, msg, data, task, role });
  }

  private save(): void {
    this.store.saveRun(this.run);
    this.onUpdate?.(this.run);
  }

  private cleanup(): void {
    for (const t of this.run.tasks) if (t.worktree) g.removeWorktree(this.store.root, t.worktree);
    if (this.integration) g.removeWorktree(this.store.root, this.integration.path);
  }
}

// Validate planner output: unique ids, known deps, no cycles.
export function normalizeTasks(raw: any[]): Task[] {
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const [i, r] of raw.entries()) {
    let id = String(r.id ?? `T${i + 1}`).trim() || `T${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    tasks.push({
      id,
      title: String(r.title ?? id),
      description: String(r.description ?? ''),
      acceptance: Array.isArray(r.acceptance) ? r.acceptance.map(String) : [],
      deps: Array.isArray(r.deps) ? r.deps.map(String) : [],
      status: 'pending',
      attempts: 0,
      notes: [],
      costUsd: 0,
    });
  }
  for (const t of tasks) t.deps = [...new Set(t.deps.filter((d) => d !== t.id && seen.has(d)))];
  // Break cycles by dropping back-edges found in a DFS.
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (t: Task) => {
    state.set(t.id, 1);
    t.deps = t.deps.filter((d) => {
      const s = state.get(d) ?? 0;
      if (s === 1) return false;
      if (s === 0) visit(byId.get(d)!);
      return true;
    });
    state.set(t.id, 2);
  };
  for (const t of tasks) if (!state.get(t.id)) visit(t);
  return tasks;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export async function runGoal(opts: ConductorOptions): Promise<Run> {
  return new Conductor(opts).execute();
}
