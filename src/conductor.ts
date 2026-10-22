// The conductor: deterministic code that coordinates LLM agents.
// plan -> parallel workers in worktrees -> tests + judge -> repair or merge queue -> learn.
// Planners never code, workers never judge, judges never edit (role separation).

import { join } from 'node:path';
import { extractJson, type AgentRequest, type AgentResult, type Runner } from './agent.ts';
import * as g from './git.ts';
import { alternateWorkerSection, comparePrompt, COMPARE_SCHEMA, contrastApplies, resolveContrast } from './contrast.ts';
import { loadHarness, type Harness } from './harness.ts';
import { formatLearnings, listDomains, normalizeDomain, readAllLearnings, readLearnings, writeLearnings, GLOBAL, type Lesson } from './learnings.ts';
import { newRunId, type Store } from './store.ts';
import type { ActiveAgent, CriterionResult, OrchestraEvent, Role, Run, Scenario, Task, Verdict } from './types.ts';

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

const LIST_LINE = /^\s*(?:[-*]\s|\d+[.)]\s)/m;
const INLINE_ITEM = /\(\d+\)/;

export function fastPathDecision(goal: string, cfg: { enabled: boolean; maxGoalChars: number }): { fast: boolean; reason: string } {
  const g = (goal ?? '').trim();
  if (!cfg.enabled) return { fast: false, reason: 'fast path disabled' };
  if (!g) return { fast: false, reason: 'empty goal' };
  if (g.length > cfg.maxGoalChars) return { fast: false, reason: `goal longer than ${cfg.maxGoalChars} chars` };
  if (LIST_LINE.test(g) || INLINE_ITEM.test(g)) return { fast: false, reason: 'goal has list structure' };
  return { fast: true, reason: 'small single-concern goal' };
}

const PLAN_BODY =
  'Produce the task graph and hidden scenarios.\nAlso set "domain": pick one existing domain slug from EXISTING DOMAINS, or propose at most one new kebab-case slug (e.g. cli, web-ui, docs, config) when none fits.';

export function plannerPrompt(i: { goal: string; files: string[]; testCommand?: string; learnings: string; domains: string[]; fastPath?: boolean }): BuiltPrompt {
  return {
    prefix: [
      `LEARNINGS:\n${i.learnings}`,
      `EXISTING DOMAINS:\n${i.domains.length ? i.domains.join('\n') : '(none yet)'}`,
      `REPOSITORY FILES (first ${i.files.length}):\n${i.files.join('\n')}`,
      `TEST COMMAND: ${i.testCommand ?? '(none configured)'}`,
      `GOAL:\n${i.goal}`,
    ].join('\n\n'),
    body: i.fastPath
      ? `${PLAN_BODY}\nThis goal is small and single-concern: return exactly one task and an empty or minimal scenarios list.`
      : PLAN_BODY,
  };
}

const firstLine = (s: string, max = 200): string => (s.split('\n')[0] ?? '').slice(0, max);

function repairSection(notes: string[], progressFile?: string): string {
  if (!progressFile) return `REPAIR NOTES (previous attempt was rejected, fix all of these):\n${bullets(notes)}`;
  return `REPAIR NOTES (previous attempt was rejected, fix all of these). Read ${progressFile} for the full diff summary and judge issues. Summary:\n${bullets(notes.map((n) => firstLine(n)))}`;
}

export const progressRel = (runId: string, taskId: string): string => `runs/${runId}/progress/${taskId}.json`;

export function buildProgress(i: { task: Task; verdict?: Verdict; issues: string[]; diffSummary: string }): object {
  const { task, verdict } = i;
  return {
    taskId: task.id,
    title: task.title,
    attempt: task.attempts,
    score: verdict?.score ?? null,
    testsPassed: verdict?.testsPassed ?? null,
    issues: i.issues,
    failingCriteria: (verdict?.criteria ?? []).filter((c) => c.pass === false),
    diffSummary: i.diffSummary,
    writtenAt: new Date().toISOString(),
  };
}

export function workerPrompt(i: { goal: string; learnings: string; testCommand?: string; task: Task; others: string[]; progressFile?: string }): BuiltPrompt {
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
      task.notes.length ? repairSection(task.notes, i.progressFile) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

const isTestFile = (f: string) => f.startsWith('test/') || f.includes('.test.');

// Source files under src/ that gained an `export` in the unified diff, when no test file changed.
export function missingTestIssues(diff: string, changed: string[]): string[] {
  if (changed.some(isTestFile)) return [];
  const gained = new Set<string>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : '';
    else if (line.startsWith('+export ') && /^src\/.+\.(ts|js)$/.test(file) && !isTestFile(file)) gained.add(file);
  }
  return gained.size ? [`New exports were added in ${[...gained].join(', ')} but no test file changed. Add or update tests under test/.`] : [];
}

export function preJudgeIssues(i: { lint: { ok: boolean; tail: string; cmd?: string } | null; testIssues: string[] }): string[] {
  const out: string[] = [];
  if (i.lint && !i.lint.ok) out.push(`Lint command \`${i.lint.cmd ?? ''}\` fails. Output tail: ${i.lint.tail.slice(-1200)}`);
  return [...out, ...i.testIssues];
}

// Cheap-judge verdicts stand only when tests pass, the score clears the threshold by more than
// the margin, and no issues were raised. A missing verdict always escalates.
export function shouldEscalate(v: Partial<Verdict> | undefined, testsOk: boolean | null, passThreshold: number, margin: number): boolean {
  if (!v || typeof v.score !== 'number') return true;
  return testsOk === false || Math.abs(v.score - passThreshold) <= margin || (v.issues?.length ?? 0) > 0;
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
      .join('\n') || '(none)'}\n\nAlso return criteria: one entry per acceptance criterion, in order, each with pass, score and a short note.`,
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
    domain: { type: 'string' },
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

export const FAST_PLAN_SCHEMA = {
  ...PLAN_SCHEMA,
  properties: { ...PLAN_SCHEMA.properties, tasks: { ...PLAN_SCHEMA.properties.tasks, maxItems: 1 } },
  required: ['tasks'],
};

// Per-criterion judging: mean score, and pass only when every criterion passes. Malformed entries are skipped.
export function aggregateCriteria(criteria: unknown): { score: number; pass: boolean; failing: CriterionResult[]; list: CriterionResult[] } | undefined {
  if (!Array.isArray(criteria)) return undefined;
  const list: CriterionResult[] = [];
  for (const c of criteria) {
    if (!c || typeof c !== 'object' || typeof c.criterion !== 'string' || typeof c.pass !== 'boolean') continue;
    const n = Number.isFinite(c.score) ? Math.min(1, Math.max(0, c.score)) : 0;
    list.push({ criterion: c.criterion, pass: c.pass, score: n, ...(typeof c.note === 'string' ? { note: c.note } : {}) });
  }
  if (!list.length) return undefined;
  return { score: list.reduce((a, c) => a + c.score, 0) / list.length, pass: list.every((c) => c.pass), failing: list.filter((c) => !c.pass), list };
}

// Combines the judge's raw verdict with test results and per-criterion results (when given).
export function buildVerdict(v: Partial<Verdict>, testsOk: boolean | null, passThreshold: number, testIssue?: string): Verdict {
  const agg = aggregateCriteria(v.criteria);
  const score = agg ? agg.score : (v.score as number);
  const pass = Boolean(v.pass) && score >= passThreshold && testsOk !== false && (agg?.pass ?? true);
  const issues = [...(v.issues ?? [])];
  if (agg) issues.unshift(...agg.failing.map((c) => `Criterion failed: ${c.criterion}${c.note ? `: ${c.note}` : ''}`));
  if (testsOk === false && testIssue) issues.unshift(testIssue);
  return { pass, score: round(score), summary: v.summary ?? '', issues, testsPassed: testsOk, ...(agg ? { criteria: agg.list } : {}) };
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, score: { type: 'number', minimum: 0, maximum: 1 }, note: { type: 'string' } },
        required: ['criterion', 'pass', 'score'],
      },
    },
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
        properties: {
          role: { type: 'string', enum: ['planner', 'worker', 'judge'] },
          lesson: { type: 'string' },
          evidence: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', properties: { run: { type: 'string' }, task: { type: 'string' } }, required: ['run'] },
          },
          hits: { type: 'number' },
        },
        required: ['role', 'lesson', 'evidence'],
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
    const learnings = readAllLearnings(store);
    const cfg = store.config();
    const files = g.trackedFiles(this.integration.path);
    const fp = fastPathDecision(run.goal, cfg.fastPath);
    const built = plannerPrompt({
      goal: run.goal,
      files,
      testCommand: cfg.testCommand,
      learnings: formatLearnings(learnings, 'planner'),
      domains: listDomains(store),
      fastPath: fp.fast,
    });
    const prompt = joinPrompt(built);

    const res = await this.call('planner', undefined, 1, {
      prompt,
      cwd: this.integration.path,
      schema: fp.fast ? FAST_PLAN_SCHEMA : PLAN_SCHEMA,
      tools: ['Read', 'Grep', 'Glob'],
    });
    const out = extractJson(res) as { tasks?: any[]; scenarios?: Scenario[]; domain?: unknown } | undefined;
    if (!res.ok || !out?.tasks?.length) throw new Error(`Planner failed: ${res.error ?? 'no tasks returned'}`);

    run.tasks = normalizeTasks(out.tasks);
    // One domain per run, so at most one new domain can appear per run.
    const domain = normalizeDomain(out.domain);
    if (domain && domain !== GLOBAL) run.domain = domain;
    else if (out.domain !== undefined && out.domain !== '') this.emit('log', `Ignoring invalid planner domain: ${JSON.stringify(out.domain)}`);
    this.scenarios = out.scenarios ?? [];
    // Holdout: only the judge ever receives these. .orchestra is outside every worktree.
    store.writeJson(`holdout/${run.id}.json`, this.scenarios);
    if (fp.fast) this.emit('log', `Fast path: ${fp.reason}`);
    this.emit('plan', `Planned ${run.tasks.length} tasks, ${this.scenarios.length} hidden scenarios`, {
      tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, deps: t.deps })),
      ...(fp.fast ? { fastPath: true } : {}),
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
    // A contrastive winner B leaves task.worktree on the -b path; retire it before reusing the normal one.
    if (task.worktree && task.worktree !== wt.path) {
      g.removeWorktree(store.root, task.worktree);
      if (task.branch && task.branch !== wt.branch) g.deleteBranch(store.root, task.branch);
    }
    task.branch = wt.branch;
    task.worktree = wt.path;
    const base = g.mergeBase(wt.path, 'HEAD', this.integration.branch);
    this.emit('task.start', `${task.id} attempt ${task.attempts}: ${task.title}`, undefined, task.id);
    this.save();

    const learnings = readAllLearnings(store);
    const others = this.run.tasks.filter((t) => t.id !== task.id).map((t) => `- ${t.id} ${t.title} [${t.status}]`);
    const prompt = joinPrompt(
      workerPrompt({
        goal: this.run.goal,
        learnings: formatLearnings(learnings, 'worker', this.run.domain),
        testCommand: cfg.testCommand,
        task,
        others,
        progressFile: task.notes.length ? store.path(progressRel(this.run.id, task.id)) : undefined,
      }),
    );

    if (contrastApplies(cfg, task)) return this.attemptContrast(task, wt, base, prompt);

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
      const issues = cfg.preJudge.enabled ? this.preJudge(task, wt.path, base) : [];
      verdict = issues.length
        ? { pass: false, score: 0, summary: 'Pre-judge checks failed', issues, testsPassed: null }
        : await this.judge(task, wt.path, base, work);
      if (issues.length) this.ledgerOutcome(task, 'prejudge_fail');
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

  // Pre-judge outcome for one attempt: a failing verdict when it never reaches the judge, else null.
  private screen(task: Task, cwd: string, base: string, work: AgentResult): Verdict | null {
    if (!work.ok && !g.hasChangesSince(cwd, base)) {
      return { pass: false, score: 0, summary: `Worker failed: ${work.error}`, issues: [`Previous attempt crashed: ${work.error}`], testsPassed: null };
    }
    if (!g.hasChangesSince(cwd, base)) return { pass: false, score: 0, summary: 'No changes were committed', issues: ['No code changes were produced. Implement the task.'], testsPassed: null };
    const issues = this.store.config().preJudge.enabled ? this.preJudge(task, cwd, base) : [];
    if (!issues.length) return null;
    this.ledgerOutcome(task, 'prejudge_fail');
    return { pass: false, score: 0, summary: 'Pre-judge checks failed', issues, testsPassed: null };
  }

  // Contrastive repair: two workers (A as usual, B told to take a different approach), one comparing judge.
  private async attemptContrast(task: Task, wtA: g.Worktree, baseA: string, promptA: string): Promise<void> {
    const { store } = this;
    const cfg = store.config();
    const threshold = this.harness.config.passThreshold;
    const idB = `${task.id}-b`;
    // Stale leftovers from an earlier pair would make createTaskWorktree reuse them.
    g.removeWorktree(store.root, join(this.wtRoot, this.run.id, idB));
    g.deleteBranch(store.root, `orchestra/${this.run.id}/${idB}`);
    const wtB = g.createTaskWorktree(store.root, this.wtRoot, this.run.id, idB, g.head(this.integration.path));
    const baseB = g.mergeBase(wtB.path, 'HEAD', this.integration.branch);
    this.emit('log', `${task.id} contrastive repair: running attempts A and B in parallel`, undefined, task.id);
    this.save();

    const common = { allowedTools: cfg.allowedTools, disallowedTools: cfg.disallowedTools, permissionMode: cfg.permissionMode };
    const promptB = `${promptA}\n\n${alternateWorkerSection(task.notes)}`;
    const [workA, workB] = await Promise.all([
      this.call('worker', task, task.attempts, { prompt: promptA, cwd: wtA.path, ...common }, undefined, 'a'),
      this.call('worker', task, task.attempts, { prompt: promptB, cwd: wtB.path, ...common }, undefined, 'b'),
    ]);
    g.commitAll(wtA.path, `${task.id}: ${task.title} (orchestra attempt ${task.attempts}, A)`);
    g.commitAll(wtB.path, `${task.id}: ${task.title} (orchestra attempt ${task.attempts}, B)`);

    task.status = 'judging';
    this.save();
    const preA = this.screen(task, wtA.path, baseA, workA);
    const preB = this.screen(task, wtB.path, baseB, workB);
    const testsOf = (cwd: string): boolean | null => (cfg.testCommand ? g.runTests(cwd, cfg.testCommand).ok : null);

    let picked: 'A' | 'B' | null = null;
    let reasons = '';
    let vA: Verdict | undefined = preA ?? undefined;
    let vB: Verdict | undefined = preB ?? undefined;
    if (preA && preB) {
      reasons = 'Neither attempt reached the judge.';
    } else if (preA || preB) {
      // Only one attempt is viable: judge it alone; nothing to compare.
      const okSide = preA ? 'B' : 'A';
      const v = okSide === 'A' ? await this.judge(task, wtA.path, baseA, workA) : await this.judge(task, wtB.path, baseB, workB);
      if (okSide === 'A') vA = v;
      else vB = v;
      if (v.judgeError) return this.contrastJudgeError(task, wtB, v.judgeError);
      if (v.pass) picked = okSide;
      reasons = `Only ${okSide} produced a judgeable change${v.pass ? '' : ', and it did not pass'}.`;
    } else {
      const testsA = testsOf(wtA.path);
      const testsB = testsOf(wtB.path);
      const headA = g.head(wtA.path);
      const headB = g.head(wtB.path);
      const prompt = joinPrompt(
        comparePrompt({ task, scenarios: this.scenarios, workerTextA: workA.text, workerTextB: workB.text, diffA: g.diffSince(wtA.path, baseA), diffB: g.diffSince(wtB.path, baseB) }),
      );
      let raw: unknown;
      let error: string | undefined;
      for (let tryNo = 1; tryNo <= 2 && raw === undefined; tryNo++) {
        const res = await this.call('judge', task, task.attempts, {
          prompt,
          cwd: wtA.path,
          schema: COMPARE_SCHEMA,
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
          allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
          disallowedTools: ['Edit', 'Write', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(rm:*)'],
          permissionMode: 'default',
        });
        // Judges never edit. If one did anyway, discard it in both worktrees.
        g.resetTo(wtA.path, headA);
        g.resetTo(wtB.path, headB);
        const out = extractJson(res) as { a?: { score?: unknown }; b?: { score?: unknown } } | undefined;
        if (res.ok && out && typeof out.a?.score === 'number' && typeof out.b?.score === 'number') raw = out;
        else {
          error = res.error ?? 'no verdict';
          if (tryNo === 1) this.emit('log', `${task.id} comparison judge failed (${error}), retrying once`, undefined, task.id);
        }
      }
      if (raw === undefined) return this.contrastJudgeError(task, wtB, error ?? 'no verdict');
      const r = resolveContrast(raw, testsA, testsB, threshold);
      ({ a: vA, b: vB, picked, reasons } = r);
    }

    task.contrast = { attempt: task.attempts, a: { branch: wtA.branch, verdict: vA }, b: { branch: wtB.branch, verdict: vB }, picked, reasons };
    const label = picked ? `${task.id} picked ${picked} over ${picked === 'A' ? 'B' : 'A'} because ${reasons}` : `${task.id} contrast: neither A nor B accepted. ${reasons}`;
    this.emit('task.contrast', label, { a: wtA.branch, b: wtB.branch, picked, reasons }, task.id);

    if (picked === 'B') {
      // B's worktree becomes the task's; A is the loser.
      g.removeWorktree(store.root, wtA.path);
      g.deleteBranch(store.root, wtA.branch);
      task.branch = wtB.branch;
      task.worktree = wtB.path;
    } else {
      g.removeWorktree(store.root, wtB.path);
      g.deleteBranch(store.root, wtB.branch);
    }

    const verdict: Verdict = (picked === 'B' ? vB : vA) ?? vA ?? vB ?? { pass: false, score: 0, summary: reasons, issues: [reasons], testsPassed: null };
    task.verdict = verdict;
    const vl = `${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.score.toFixed(2)}`;
    this.emit('task.verdict', `${task.id} ${vl}: ${verdict.summary}`, { verdict }, task.id);
    if (!picked) {
      const issues = (vA?.issues.length ? vA.issues : vA ? [vA.summary] : [reasons]).filter(Boolean);
      return this.repairOrFail(task, issues);
    }
    task.status = 'merging';
    this.save();
    await this.enqueueMerge(task);
  }

  private contrastJudgeError(task: Task, wtB: g.Worktree, error: string): void {
    g.removeWorktree(this.store.root, wtB.path);
    g.deleteBranch(this.store.root, wtB.branch);
    this.ledgerOutcome(task, 'judge_error');
    this.fail(task, `judge failed twice: ${error}. Raise budgetUsd.judge in the harness config or re-run`);
  }

  // Cheap deterministic checks that run before any judge call.
  private preJudge(task: Task, cwd: string, base: string): string[] {
    const { lintCommand, requireTests } = this.store.config().preJudge;
    const lint = lintCommand ? { ...g.runTests(cwd, lintCommand), cmd: lintCommand } : null;
    const testIssues = requireTests ? missingTestIssues(g.diffSince(cwd, base), g.changedFiles(cwd, base)) : [];
    const issues = preJudgeIssues({ lint, testIssues });
    if (issues.length) this.emit('log', `${task.id} pre-judge checks failed (${issues.length}), skipping judge`, undefined, task.id);
    return issues;
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

    const testsOk = tests ? tests.ok : null;
    const runJudge = async (model?: string): Promise<{ res: AgentResult; v?: Partial<Verdict> }> => {
      const res = await this.call(
        'judge',
        task,
        task.attempts,
        {
          prompt,
          cwd,
          schema: VERDICT_SCHEMA,
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
          allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
          disallowedTools: ['Edit', 'Write', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(rm:*)'],
          permissionMode: 'default',
        },
        model,
      );
      // Judges never edit. If one did anyway, discard it.
      g.resetTo(cwd, headBefore);
      const v = extractJson(res) as Partial<Verdict> | undefined;
      return { res, v: res.ok && v && typeof v.score === 'number' ? v : undefined };
    };

    // Tiered judging (off by default): a cheap verdict stands only when it is clean and confident.
    let v: Partial<Verdict> | undefined;
    let error: string | undefined;
    const tiers = cfg.judgeTiers;
    if (tiers.enabled) {
      const cheap = await runJudge(tiers.cheapModel);
      if (cheap.v && !shouldEscalate(cheap.v, testsOk, this.harness.config.passThreshold, tiers.margin)) v = cheap.v;
      else this.emit('log', `${task.id} cheap judge not decisive, escalating to ${this.harness.config.models.judge}`, undefined, task.id);
    }

    // A judge crash or budget exhaustion says nothing about the worker: retry the judge alone, once.
    for (let tryNo = 1; tryNo <= 2 && !v; tryNo++) {
      const r = await runJudge();
      v = r.v;
      if (v) break;
      error = r.res.error ?? 'no verdict';
      if (tryNo === 1) this.emit('log', `${task.id} judge failed (${error}), retrying judge once`, undefined, task.id);
    }
    if (!v || typeof v.score !== 'number') {
      return { pass: false, score: 0, summary: `Judge failed twice: ${error}`, issues: [], testsPassed: tests?.ok ?? null, judgeError: error };
    }
    return buildVerdict(v, testsOk, this.harness.config.passThreshold, testsOk === false ? `Test command \`${cfg.testCommand}\` fails. Output tail:\n${tests!.tail.slice(-1200)}` : undefined);
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
    this.writeProgress(task, issues);
    task.notes = issues;
    task.status = 'repair';
    this.emit('task.repair', `${task.id} -> repair: ${issues[0]?.split('\n')[0] ?? ''}`, { issues }, task.id);
    this.save();
  }

  // Repair attempts read this file instead of getting long text inlined in the prompt.
  private writeProgress(task: Task, issues: string[]): void {
    let diffSummary = '';
    if (task.worktree) {
      try {
        diffSummary = g.diffStat(task.worktree, g.mergeBase(task.worktree, 'HEAD', this.integration.branch));
      } catch (e) {
        this.emit('log', `${task.id} diff summary unavailable: ${(e as Error).message.split('\n')[0]}`, undefined, task.id);
      }
    }
    this.store.writeJson(progressRel(this.run.id, task.id), buildProgress({ task, verdict: task.verdict, issues, diffSummary }));
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
          t.contrast ? `  contrast (run ${run.id}, task ${t.id}, attempt ${t.contrast.attempt}): ${t.contrast.picked ? `picked ${t.contrast.picked} over ${t.contrast.picked === 'A' ? 'B' : 'A'}` : 'no pick'} because ${t.contrast.reasons}` : '',
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
    const existing = { domain: run.domain ?? GLOBAL, lessons: readLearnings(store, run.domain), global: run.domain ? readLearnings(store) : [] };
    const res = await this.call('librarian', undefined, 1, {
      prompt: [
        `RUN ID: ${run.id}\nTASK IDS: ${run.tasks.map((t) => t.id).join(', ')}\nDOMAIN: ${run.domain ?? GLOBAL}\nEvery lesson must cite evidence ({run, task?}); lessons without evidence are dropped. Return the full revised lesson set for this domain.`,
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
      writeLearnings(store, out.lessons, run.id, run.domain);
      const kept = readLearnings(store, run.domain).length;
      const dropped = Math.max(0, out.lessons.length - kept);
      this.emit('learn', `Learnings updated: ${kept} lessons kept, ${dropped} dropped (${run.domain ?? GLOBAL})`, { count: kept, kept, dropped, domain: run.domain ?? GLOBAL });
    } else {
      this.emit('log', `Librarian failed: ${res.error ?? 'no lessons'}`);
    }
  }

  // ---------- plumbing ----------

  private async call(role: Role, task: Task | undefined, attempt: number, req: Omit<AgentRequest, 'role' | 'system' | 'model' | 'budgetUsd'>, modelOverride?: string, variant?: 'a' | 'b'): Promise<AgentResult> {
    const { run, harness } = this;
    const sfx = variant ? `-${variant}` : '';
    const model = modelOverride ?? harness.config.models[role];
    const agent: ActiveAgent = {
      key: `${role}:${task?.id ?? '-'}:${attempt}${sfx}`,
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
      logFile: this.store.path('runs', run.id, 'logs', `${task?.id ?? 'run'}-${role}-${attempt}${sfx}.jsonl`),
      meta: { task: task?.id, attempt, run: run.id, variant },
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
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      cacheReadTokens: res.usage?.cacheReadTokens,
      cacheWriteTokens: res.usage?.cacheWriteTokens,
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
