// The conductor: deterministic code that coordinates LLM agents.
// plan -> parallel workers in worktrees -> tests + judge -> repair or merge queue -> learn.
// Planners never code, workers never judge, judges never edit (role separation).

import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractJson, parseWorkerOutcome, type AgentRequest, type AgentResult, type Runner } from './agent.ts';
import * as g from './git.ts';
import { alternateWorkerSection, comparePrompt, COMPARE_SCHEMA, contrastApplies, resolveContrast } from './contrast.ts';
import { aggregatePanel, lineageFraming, pairwiseBothOrders, type PanelJudgeVote } from './panel.ts';
import { isExcludedPath, loadOrBuildAtlas, type Atlas } from './atlas.ts';
import { buildTaskPack, renderMap } from './atlas-context.ts';
import { plannedFiles } from './exploration.ts';
import { buildContract, contractSha, unresolvedAmbiguities } from './contracts.ts';
import { analyzeDiff, MONITOR_MARK, type IntegrityFlag } from './integrity.ts';
import { loadHarness, type Harness } from './harness.ts';
import { applyLessonEdits, editsFromResponse, expireDomain, formatLearnings, listDomains, normalizeDomain, readAllLearnings, readLearnings, GLOBAL } from './learnings.ts';
import { buildSandboxPolicy, preflightSandbox, scrubWorkerEnv, type ProbeExec } from './sandbox.ts';
import { newRunId, type Store } from './store.ts';
import type { ActiveAgent, CriterionResult, OrchestraEvent, PanelRecord, Role, Run, Scenario, Task, Verdict } from './types.ts';

export interface Ablation {
  scenarios?: boolean; // the judge and contrast comparer see no hidden scenarios
  repair?: boolean; // one attempt per task, no repair loop
  learnings?: boolean; // planner and workers get no learnings
  contrastive?: boolean; // never run contrastive repair
}

export interface ConductorOptions {
  store: Store;
  runner: Runner;
  goal: string;
  harnessVersion?: string;
  baseRef?: string; // eval runs pin the starting commit
  kind?: 'goal' | 'eval';
  // Opt-in ablation: turn one component off. Unset keeps the normal behaviour.
  ablate?: Ablation;
  // Opt-in: an eval replay reads the learnings store (the with-lessons arm of `evals ablation`). Default is clean-room.
  evalLearnings?: boolean;
  onUpdate?: (run: Run) => void;
  // Opt-in OS sandbox for write-capable roles (worker). Unset keeps spawning exactly as before.
  sandbox?: { backend: 'srt' | 'claude' | 'docker'; allowedHosts?: string[]; image?: string; gvisor?: boolean; network?: string };
  // Unattended: strip push and publish credentials from every agent env, even without a sandbox object.
  unattended?: boolean;
  // Injectable exec for the sandbox pre-flight probes (tests). Defaults to spawnSync.
  preflightExec?: ProbeExec;
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

export function plannerPrompt(i: { goal: string; files: string[]; testCommand?: string; learnings: string; domains: string[]; fastPath?: boolean; map?: string }): BuiltPrompt {
  return {
    prefix: [
      `LEARNINGS:\n${i.learnings}`,
      `EXISTING DOMAINS:\n${i.domains.length ? i.domains.join('\n') : '(none yet)'}`,
      i.map ? `REPOSITORY MAP:\n${i.map}` : `REPOSITORY FILES (first ${i.files.length}):\n${i.files.join('\n')}`,
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

// Optional evolvable guidance: a labelled section only when the text is non-blank.
const guidanceSection = (label: string, text?: string): string => (text?.trim() ? `${label}:\n${text.trim()}` : '');

export function workerPrompt(i: {
  goal: string;
  learnings: string;
  testCommand?: string;
  task: Task;
  others: string[];
  progressFile?: string;
  tools?: string;
  style?: string;
  map?: string; // L0 repo map, shared prefix
  pack?: string; // L1 task pack, body only
}): BuiltPrompt {
  const { task } = i;
  return {
    prefix: [
      `LEARNINGS:\n${i.learnings}`,
      `TEST COMMAND: ${i.testCommand ?? '(none configured; run relevant tests you find)'}`,
      `OVERALL GOAL (context only):\n${i.goal}`,
      guidanceSection('TOOL GUIDANCE', i.tools),
      guidanceSection('STYLE', i.style),
      i.map ? `REPOSITORY MAP:\n${i.map}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    body: [
      `YOUR TASK ${task.id}: ${task.title}\n${task.description}`,
      `ACCEPTANCE CRITERIA:\n${bullets(task.acceptance)}`,
      i.pack ?? '',
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
  tools?: string;
  checklist?: string;
}): BuiltPrompt {
  const { task, tests } = i;
  const base = `HIDDEN SCENARIOS for the whole goal (judge only the parts this task is responsible for):\n${i.scenarios
    .map((s) => `- ${s.id}: GIVEN ${s.given} WHEN ${s.when} THEN ${s.then}`)
    .join('\n') || '(none)'}\n\nAlso return criteria: one entry per acceptance criterion, in order, each with pass, score and a short note.`;
  return {
    prefix: [base, guidanceSection('TOOL GUIDANCE', i.tools), guidanceSection('REVIEW CHECKLIST', i.checklist)].filter(Boolean).join('\n\n'),
    body: [
      `TASK ${task.id}: ${task.title}\n${task.description}`,
      `ACCEPTANCE CRITERIA:\n${bullets(task.acceptance)}`,
      `WORKER SUMMARY (unverified):\n${i.workerText.slice(0, 3000)}`,
      tests ? `TEST RESULT (${i.testCommand}): ${tests.ok ? 'PASSED' : 'FAILED'}\n${tests.tail}` : 'TEST RESULT: no test command configured',
      `DIFF vs base:\n${i.diff}`,
    ].join('\n\n'),
  };
}

// One judge's per-criterion binary verdicts, keyed by the acceptance text when the judge answered
// in order (as asked), else by its own criterion text. No criteria falls back to one overall criterion.
export function panelCriteria(v: Partial<Verdict>, acceptance: string[]): Record<string, boolean> {
  const list = aggregateCriteria(v.criteria)?.list;
  if (!list) return { overall: Boolean(v.pass) };
  const byOrder = list.length === acceptance.length;
  return Object.fromEntries(list.map((c, i) => [byOrder ? acceptance[i] : c.criterion, c.pass]));
}

// Clear-majority panel verdict: per-criterion majority, mean scores, issues from every judge.
export function panelMajorityVerdict(raws: Partial<Verdict>[], majority: Record<string, boolean>, acceptance: string[]): Partial<Verdict> {
  const keys = Object.keys(majority);
  const score = raws.reduce((a, r) => a + Number(r.score), 0) / raws.length;
  const issues = [...new Set(raws.flatMap((r) => r.issues ?? []))];
  const lead = raws.find((r) => r.pass === (raws.filter((x) => x.pass).length * 2 > raws.length)) ?? raws[0];
  const perCriterion = keys.length === 1 && keys[0] === 'overall' ? undefined : keys.map((criterion) => {
    const scores = raws.flatMap((r) => {
      const list = aggregateCriteria(r.criteria)?.list;
      if (!list) return [];
      const c = list.length === acceptance.length ? list[acceptance.indexOf(criterion)] : list.find((x) => x.criterion === criterion);
      return c ? [c.score] : [];
    });
    return { criterion, pass: majority[criterion], score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : majority[criterion] ? 1 : 0 };
  });
  return { pass: Object.values(majority).every(Boolean), score, summary: lead.summary ?? '', issues, ...(perCriterion ? { criteria: perCriterion } : {}) };
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
          invariants: { type: 'array', items: { type: 'string' } },
          footprint: {
            type: 'object',
            properties: { files: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } } },
            required: ['files'],
          },
        },
        required: ['id', 'title', 'description', 'acceptance', 'deps'],
      },
    },
    ambiguities: {
      type: 'array',
      items: { type: 'object', properties: { question: { type: 'string' }, resolution: { type: 'string' } }, required: ['question'] },
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

const EVIDENCE_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: { type: 'object', properties: { run: { type: 'string' }, task: { type: 'string' } }, required: ['run'] },
};

// Item edits only: the librarian addresses lessons by id and never returns the whole set.
const LESSONS_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'remove'] },
          id: { type: 'string' },
          role: { type: 'string', enum: ['planner', 'worker', 'judge'] },
          lesson: { type: 'string' },
          evidence: EVIDENCE_SCHEMA,
          helped: { type: 'boolean' },
        },
        required: ['op'],
      },
    },
  },
  required: ['edits'],
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
  private readonly sandboxOpt?: ConductorOptions['sandbox'];
  private readonly scrubEnv: boolean;
  private readonly preflightExec?: ProbeExec;
  private readonly harness: Harness;
  private readonly onUpdate?: (run: Run) => void;
  private scenarios: Scenario[] = [];
  private atlas?: Atlas;
  private map = '';
  private ablate: Ablation;
  private evalLearnings: boolean;
  private integration!: { path: string; branch: string; base: string };
  private mergeChain: Promise<unknown> = Promise.resolve();
  private readonly wtRoot: string;

  constructor(opts: ConductorOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.harness = loadHarness(opts.store, opts.harnessVersion);
    this.onUpdate = opts.onUpdate;
    this.sandboxOpt = opts.sandbox;
    this.preflightExec = opts.preflightExec;
    this.scrubEnv = Boolean(opts.sandbox || opts.unattended);
    this.ablate = opts.ablate ?? {};
    this.evalLearnings = opts.evalLearnings ?? false;
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

      this.sandboxPreflight();
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
      if (run.status === 'failed' && !run.error) {
        const human = run.tasks.filter((t) => t.status === 'needs_human').length;
        const blocked = run.tasks.filter((t) => t.status === 'blocked').length;
        const failed = run.tasks.length - merged.length - human - blocked;
        run.error = `${run.tasks.length - merged.length} of ${run.tasks.length} tasks did not land (${failed} failed, ${blocked} blocked, ${human} need a human)`;
      }
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
    // Eval replays are clean-room: they never read the learnings store, so the lessons a harness
    // accumulated on past goals cannot leak into the comparison.
    const isEval = run.kind === 'eval';
    const learnings = (isEval && !this.evalLearnings) || this.ablate.learnings ? {} : readAllLearnings(store);
    const cfg = store.config();
    const files = g.trackedFiles(this.integration.path);
    this.loadAtlas();
    const fp = fastPathDecision(run.goal, cfg.fastPath);
    const built = plannerPrompt({
      goal: run.goal,
      files,
      testCommand: cfg.testCommand,
      learnings: formatLearnings(learnings, 'planner'),
      domains: isEval ? [] : listDomains(store),
      fastPath: fp.fast,
      map: this.map || undefined,
    });
    const prompt = joinPrompt(built);

    const res = await this.call('planner', undefined, 1, {
      prompt,
      cwd: this.integration.path,
      schema: fp.fast ? FAST_PLAN_SCHEMA : PLAN_SCHEMA,
      tools: ['Read', 'Grep', 'Glob'],
    });
    const out = extractJson(res) as { tasks?: any[]; scenarios?: Scenario[]; domain?: unknown; ambiguities?: unknown } | undefined;
    if (!res.ok || !out?.tasks?.length) throw new Error(`Planner failed: ${res.error ?? 'no tasks returned'}`);

    // W4.3: an unresolved ambiguity blocks the plan before any task exists, so no worker starts.
    if (cfg.verification.contracts.enabled) {
      const open = unresolvedAmbiguities(out.ambiguities);
      if (open.length) throw new Error(`Plan blocked by ${open.length} unresolved ambiguit${open.length === 1 ? 'y' : 'ies'}:\n${open.map((q) => `- ${q}`).join('\n')}`);
    }
    run.tasks = normalizeTasks(out.tasks);
    if (cfg.verification.contracts.enabled) {
      const contract = buildContract(run.tasks);
      const rel = `runs/${run.id}/contract.json`;
      store.writeJson(rel, contract);
      run.contract = { path: rel, sha256: contractSha(contract) };
    }
    // One domain per run, so at most one new domain can appear per run.
    const domain = normalizeDomain(out.domain);
    if (domain && domain !== GLOBAL) run.domain = domain;
    else if (out.domain !== undefined && out.domain !== '') this.emit('log', `Ignoring invalid planner domain: ${JSON.stringify(out.domain)}`);
    this.scenarios = this.ablate.scenarios ? [] : (out.scenarios ?? []);
    // Holdout: only the judge ever receives these. .orchestra is outside every worktree.
    store.writeJson(`holdout/${run.id}.json`, this.scenarios);
    if (fp.fast) this.emit('log', `Fast path: ${fp.reason}`);
    this.emit('plan', `Planned ${run.tasks.length} tasks, ${this.scenarios.length} hidden scenarios`, {
      tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, deps: t.deps })),
      ...(fp.fast ? { fastPath: true } : {}),
    });
    this.save();
  }

  // Opt-in Repo Atlas: built or loaded once per run at the integration base. Any failure is logged
  // and the run proceeds with the old prompts.
  private loadAtlas(): void {
    const cfg = this.store.config().context.atlas;
    if (!cfg.enabled) return;
    try {
      this.atlas = loadOrBuildAtlas(this.store.root, this.integration.base);
      this.run.atlasSha = this.atlas.sha;
      this.map = renderMap(this.atlas, this.run.goal, cfg.mapTokens);
      this.emit('log', `Atlas ready at ${this.atlas.sha.slice(0, 8)} (${Object.keys(this.atlas.files).length} files)`);
    } catch (e) {
      this.atlas = undefined;
      this.map = '';
      this.emit('log', `Atlas unavailable, continuing without it: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // L1 pack for one task: footprint skeletons plus files changed on integration since run start.
  private taskPack(task: Task): string | undefined {
    const cfg = this.store.config().context.atlas;
    if (!this.atlas || !cfg.packs) return undefined;
    try {
      const changed = g.changedFiles(this.integration.path, this.integration.base);
      return buildTaskPack(this.atlas, task.footprint ?? { files: [] }, changed, cfg.packTokens) || undefined;
    } catch (e) {
      this.emit('log', `${task.id} task pack unavailable: ${(e as Error).message.split('\n')[0]}`, undefined, task.id);
      return undefined;
    }
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

    const learnings = (this.run.kind === 'eval' && !this.evalLearnings) || this.ablate.learnings ? {} : readAllLearnings(store);
    const others = this.run.tasks.filter((t) => t.id !== task.id).map((t) => `- ${t.id} ${t.title} [${t.status}]`);
    const prompt = joinPrompt(
      workerPrompt({
        goal: this.run.goal,
        learnings: formatLearnings(learnings, 'worker', this.run.domain),
        testCommand: cfg.testCommand,
        task,
        others,
        progressFile: task.notes.length ? store.path(progressRel(this.run.id, task.id)) : undefined,
        tools: harness.guidance.tools,
        style: harness.guidance.style,
        map: this.map || undefined,
        pack: this.taskPack(task),
      }),
    );

    if (!this.ablate.contrastive && contrastApplies(cfg, task)) return this.attemptContrast(task, wt, base, prompt);

    const work = await this.call('worker', task, task.attempts, {
      prompt,
      cwd: wt.path,
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      permissionMode: cfg.permissionMode,
    });
    g.commitAll(wt.path, `${task.id}: ${task.title} (orchestra attempt ${task.attempts})`);

    // A flagged contradiction stops the loop: no judge, no repair, not counted as a failure.
    const flag = work.ok ? parseWorkerOutcome(work) : undefined;
    if (flag?.outcome === 'flag_for_human') return this.flagForHuman(task, flag.reason);

    // ---- self-evaluation ----
    task.status = 'judging';
    this.save();
    let verdict: Verdict;
    if (!work.ok && !g.hasChangesSince(wt.path, base)) {
      verdict = { pass: false, score: 0, summary: `Worker failed: ${work.error}`, issues: [`Previous attempt crashed: ${work.error}`], testsPassed: null };
    } else if (!g.hasChangesSince(wt.path, base)) {
      verdict = { pass: false, score: 0, summary: 'No changes were committed', issues: ['No code changes were produced. Implement the task.'], testsPassed: null };
    } else {
      // Grading surface touched: graded on the restored originals and sent straight to repair.
      const tampered = this.integrityVerdict(task, wt.path, base);
      const issues = tampered || !cfg.preJudge.enabled ? [] : this.preJudge(task, wt.path, base);
      verdict = tampered ?? (issues.length
        ? { pass: false, score: 0, summary: 'Pre-judge checks failed', issues, testsPassed: null }
        : await this.judge(task, wt.path, base, work));
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

  // Integrity monitor: analyze the worker's diff and persist the flags. When tests or other grading
  // files were tampered with, re-run the test command with the base versions restored and grade on
  // that. Returns a failing verdict (with an automatic repair note) in that case, else null.
  private integrityVerdict(task: Task, cwd: string, base: string): Verdict | null {
    const flags = analyzeDiff(g.diffSince(cwd, base, Infinity), g.changedFiles(cwd, base));
    if (!flags.length) return null;
    task.integrityFlags = [...(task.integrityFlags ?? []), ...flags];
    this.emit('log', `${task.id} integrity monitor: ${flags.length} flag(s)`, { flags }, task.id);
    // Only edits to files that existed at base are tampering; newly added tests are normal work.
    const tampered = flags.filter((f) => (f.kind === 'grading-surface' || f.kind === 'weakened-test') && g.existsAtRef(cwd, base, f.file));
    const list = (fs: IntegrityFlag[]) => fs.map((f) => `${f.kind} in ${f.file} (${f.detail})`);
    if (!tampered.length) return null;
    const files = [...new Set(tampered.map((f) => f.file))];
    const cmd = this.store.config().testCommand;
    let testsPassed: boolean | null = null;
    let tail = '';
    if (cmd) {
      const headBefore = g.head(cwd);
      g.restoreFromRef(cwd, base, files);
      const t = g.runTests(cwd, cmd);
      g.resetTo(cwd, headBefore);
      testsPassed = t.ok;
      tail = t.ok ? '' : ` Tests on the original files failed:\n${t.tail.slice(-1200)}`;
      this.emit('log', `${task.id} tests with original grading files restored ${t.ok ? 'passed' : 'FAILED'}`, undefined, task.id);
    }
    this.ledgerOutcome(task, 'integrity_flag');
    const issue = `${MONITOR_MARK} Your change touched grading files that must not be edited: ${list(tampered).join('; ')}. Revert them to their original content and fix the code instead. If a test change is truly required, stop and report FLAG_FOR_HUMAN with the reason.${tail}`;
    return { pass: false, score: 0, summary: `${MONITOR_MARK} grading surface modified: ${files.join(', ')}`, issues: [issue], testsPassed };
  }

  // Pre-judge outcome for one attempt: a failing verdict when it never reaches the judge, else null.
  private screen(task: Task, cwd: string, base: string, work: AgentResult): Verdict | null {
    if (!work.ok && !g.hasChangesSince(cwd, base)) {
      return { pass: false, score: 0, summary: `Worker failed: ${work.error}`, issues: [`Previous attempt crashed: ${work.error}`], testsPassed: null };
    }
    if (!g.hasChangesSince(cwd, base)) return { pass: false, score: 0, summary: 'No changes were committed', issues: ['No code changes were produced. Implement the task.'], testsPassed: null };
    const tampered = this.integrityVerdict(task, cwd, base);
    if (tampered) return tampered;
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

    // Either contrastive worker flagging a contradiction stops the task for a human.
    for (const w of [workA, workB]) {
      const flag = w.ok ? parseWorkerOutcome(w) : undefined;
      if (flag?.outcome === 'flag_for_human') {
        // The task stays on worktree A; retire the unused B worktree and branch.
        g.removeWorktree(store.root, wtB.path);
        g.deleteBranch(store.root, wtB.branch);
        return this.flagForHuman(task, flag.reason);
      }
    }

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
      const diffA = g.diffSince(wtA.path, baseA);
      const diffB = g.diffSince(wtB.path, baseB);
      const prompt = joinPrompt(
        comparePrompt({ task, scenarios: this.scenarios, workerTextA: workA.text, workerTextB: workB.text, diffA, diffB }),
      );
      const compareOnce = async (text: string): Promise<{ raw?: unknown; error?: string }> => {
        let raw: unknown;
        let error: string | undefined;
        for (let tryNo = 1; tryNo <= 2 && raw === undefined; tryNo++) {
          const res = await this.call('judge', task, task.attempts, {
            prompt: text,
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
        return { raw, error };
      };
      const first = await compareOnce(prompt);
      if (first.raw === undefined) return this.contrastJudgeError(task, wtB, first.error ?? 'no verdict');
      const r = resolveContrast(first.raw, testsA, testsB, threshold);
      ({ a: vA, b: vB, picked, reasons } = r);
      if (cfg.verification.panel.enabled) {
        // Both orders: the same comparison with the candidates swapped. A pick that flips with position is position bias, so no pick.
        const swapped = joinPrompt(
          comparePrompt({ task, scenarios: this.scenarios, workerTextA: workB.text, workerTextB: workA.text, diffA: diffB, diffB: diffA }),
        );
        const second = await compareOnce(swapped);
        const pref = (x: unknown): 'A' | 'B' | null => {
          const p = (x as { preferred?: unknown } | undefined)?.preferred;
          return p === 'A' || p === 'B' ? p : null;
        };
        const consistent = pairwiseBothOrders(pref(first.raw), pref(second.raw));
        this.emit('log', `${task.id} comparison in both orders: ${second.raw === undefined ? 'swapped run failed' : consistent ? `consistent pick ${consistent}` : 'orders disagree'}`, { consistent }, task.id);
        if (!consistent) {
          picked = null;
          reasons = `Panel comparison in both orders was not consistent (${second.raw === undefined ? `swapped run failed: ${second.error}` : 'position bias'}), so no attempt was picked. ${reasons}`.trim();
        }
      }
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
    const built = judgePrompt({
        task,
        scenarios: this.scenarios,
        workerText: work.text,
        testCommand: cfg.testCommand,
        tests,
        diff: g.diffSince(cwd, base),
        tools: this.harness.guidance.tools,
        checklist: this.harness.guidance.checklist,
      });
    const prompt = joinPrompt(built);

    const testsOk = tests ? tests.ok : null;
    const runJudge = async (model?: string, framing = ''): Promise<{ res: AgentResult; v?: Partial<Verdict> }> => {
      const res = await this.call(
        'judge',
        task,
        task.attempts,
        {
          prompt: framing ? joinPrompt({ ...built, prefix: `${framing}\n\n${built.prefix}` }) : prompt,
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
    const panelCfg = cfg.verification.panel;
    let panel: PanelRecord | undefined;
    let retryModel: string | undefined;
    if (panelCfg.enabled && panelCfg.judges.length) {
      // Panel judging (opt-in): every member votes per criterion; a split vote goes to the escalation model.
      const votes: PanelJudgeVote[] = [];
      const raws: Partial<Verdict>[] = [];
      for (const [i, member] of panelCfg.judges.entries()) {
        const lineage = member.lineage ?? 'default';
        const r = await runJudge(member.model, lineageFraming(lineage));
        if (!r.v) {
          this.emit('log', `${task.id} panel judge ${i + 1} (${member.model}) gave no verdict (${r.res.error ?? 'no verdict'}), skipped`, undefined, task.id);
          continue;
        }
        votes.push({ judge: `j${i + 1}`, model: member.model, lineage, criteria: panelCriteria(r.v, task.acceptance) });
        raws.push(r.v);
      }
      if (votes.length) {
        const agg = aggregatePanel(votes);
        const escalated = agg.split;
        panel = {
          votes: votes.map((vote, i) => ({ judge: vote.judge, model: vote.model, lineage: vote.lineage, pass: Boolean(raws[i].pass), score: Number(raws[i].score), criteria: vote.criteria })),
          disagreement: round(agg.disagreement),
          perCriterion: agg.perCriterion.map((c) => ({ criterion: c.criterion, pass: c.pass, fail: c.fail, disagreement: round(c.disagreement) })),
          escalated,
        };
        this.emit('log', `${task.id} judge panel of ${votes.length}: disagreement ${panel.disagreement.toFixed(2)}${escalated ? ', split vote, escalating' : ''}`, { disagreement: panel.disagreement, judges: votes.length, escalated }, task.id);
        if (escalated) retryModel = panelCfg.escalateModel ?? this.harness.config.models.judge;
        else v = panelMajorityVerdict(raws, agg.majority, task.acceptance);
      }
    } else if (tiers.enabled) {
      const cheap = await runJudge(tiers.cheapModel);
      if (cheap.v && !shouldEscalate(cheap.v, testsOk, this.harness.config.passThreshold, tiers.margin)) v = cheap.v;
      else this.emit('log', `${task.id} cheap judge not decisive, escalating to ${this.harness.config.models.judge}`, undefined, task.id);
    }

    // A judge crash or budget exhaustion says nothing about the worker: retry the judge alone, once.
    for (let tryNo = 1; tryNo <= 2 && !v; tryNo++) {
      const r = await runJudge(retryModel);
      v = r.v;
      if (v) break;
      error = r.res.error ?? 'no verdict';
      if (tryNo === 1) this.emit('log', `${task.id} judge failed (${error}), retrying judge once`, undefined, task.id);
    }
    if (!v || typeof v.score !== 'number') {
      return { pass: false, score: 0, summary: `Judge failed twice: ${error}`, issues: [], testsPassed: tests?.ok ?? null, judgeError: error };
    }
    const verdict = buildVerdict(v, testsOk, this.harness.config.passThreshold, testsOk === false ? `Test command \`${cfg.testCommand}\` fails. Output tail:\n${tests!.tail.slice(-1200)}` : undefined);
    return panel ? { ...verdict, panel } : verdict;
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
    const footprint = this.footprint(task);
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
    this.ledgerOutcome(task, 'merged', footprint);
    this.emit('task.merged', `${task.id} merged (attempt ${task.attempts})`, undefined, task.id);
    this.save();
  }

  // Passive: planned files are repo paths named in the task text, so the metric means the same with
  // the atlas on or off. Planner-declared footprint files go in `declared`, intersected with tracked
  // files because the planner may name paths that do not exist. Changed files come from the task branch diff.
  private footprint(task: Task): { planned: string[]; changed: string[]; declared?: string[] } | undefined {
    try {
      const tracked = g.trackedFiles(this.integration.path, 100_000);
      const planned = plannedFiles([task.title, task.description, ...task.acceptance].join('\n'), tracked);
      const known = new Set(tracked);
      const declared = task.footprint?.files.length ? task.footprint.files.filter((f) => known.has(f)) : undefined;
      const changed = g.changedFiles(task.worktree!, g.mergeBase(task.worktree!, 'HEAD', this.integration.branch));
      return declared ? { planned, changed, declared } : { planned, changed };
    } catch (e) {
      this.emit('log', `${task.id} footprint unavailable: ${(e as Error).message.split('\n')[0]}`, undefined, task.id);
      return undefined;
    }
  }

  private repairOrFail(task: Task, issues: string[]): void {
    if (task.attempts >= (this.ablate.repair ? 1 : this.harness.config.maxAttempts)) {
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

  private flagForHuman(task: Task, reason: string): void {
    task.status = 'needs_human';
    task.humanReason = reason;
    task.endedAt = Date.now();
    this.ledgerOutcome(task, 'needs_human');
    this.emit('task.needs_human', `${task.id} needs a human: ${reason}`, { reason }, task.id);
    for (const t of this.run.tasks) if (t.deps.includes(task.id) && (t.status === 'pending' || t.status === 'repair')) this.block(t, `${task.id} needs a human`);
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
          t.humanReason ? `  flagged for human: ${t.humanReason}` : '',
          t.verdict && !t.verdict.summary.includes(MONITOR_MARK) ? `  final verdict ${t.verdict.score}: ${t.verdict.summary}` : '',
          // Monitor wording must not reach the librarian: lessons feed the evolver, which could learn to evade it.
          ...t.notes.filter((n) => !n.includes(MONITOR_MARK)).map((n) => `  repair note: ${n.split('\n')[0]}`),
          t.contrast ? `  contrast (run ${run.id}, task ${t.id}, attempt ${t.contrast.attempt}): ${t.contrast.picked ? `picked ${t.contrast.picked} over ${t.contrast.picked === 'A' ? 'B' : 'A'}` : 'no pick'} because ${t.contrast.reasons}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
    const events = store
      .events(run.id)
      .filter((e) => e.kind === 'task.repair' || e.kind === 'task.failed' || e.kind === 'task.needs_human')
      .filter((e) => !e.msg.includes(MONITOR_MARK))
      .map((e) => `- ${e.msg}`)
      .join('\n');
    const existing = { domain: run.domain ?? GLOBAL, lessons: readLearnings(store, run.domain), global: run.domain ? readLearnings(store) : [] };
    const res = await this.call('librarian', undefined, 1, {
      prompt: [
        `RUN ID: ${run.id}\nTASK IDS: ${run.tasks.map((t) => t.id).join(', ')}\nDOMAIN: ${run.domain ?? GLOBAL}\nEvery lesson must cite evidence ({run, task?}); lessons without evidence are dropped. Return item edits only (add, update or remove by lesson id); lessons you do not mention are kept.`,
        `RUN REPORT\nGoal: ${run.goal}\nSatisfaction: ${run.satisfaction}\nCost: $${run.costUsd.toFixed(2)}\n${report}`,
        `REPAIRS AND FAILURES:\n${events || '(none)'}`,
        `EXISTING LEARNINGS:\n${JSON.stringify(existing, null, 2)}`,
      ].join('\n\n'),
      cwd: this.integration.path,
      schema: LESSONS_SCHEMA,
      tools: [],
    });
    const out = extractJson(res) as { edits?: unknown; lessons?: unknown } | undefined;
    if (res.ok && (Array.isArray(out?.edits) || Array.isArray(out?.lessons))) {
      // Model output only ever becomes item edits, even when it is shaped like a full rewrite.
      const applied = applyLessonEdits(store, run.domain, editsFromResponse(out, existing.lessons), run.id);
      const expired = expireDomain(store, run.domain, store.config().learnings?.expiryDays ?? 0, run.id);
      const kept = readLearnings(store, run.domain).length;
      const dropped = applied.removed + applied.evicted + expired;
      this.emit('learn', `Learnings updated: ${kept} lessons kept, ${dropped} dropped (${run.domain ?? GLOBAL})`, { count: kept, kept, dropped, domain: run.domain ?? GLOBAL });
    } else {
      this.emit('log', `Librarian failed: ${res.error ?? 'no lessons'}`);
    }
  }

  // ---------- plumbing ----------

  // The common git dir is the same for every worktree of the repo; resolve it once per run.
  private gitCommonDirMemo?: string;
  private gitCommonDir(): string {
    return (this.gitCommonDirMemo ??= resolve(this.store.root, g.git(this.store.root, 'rev-parse', '--git-common-dir')));
  }

  private workerPolicy(cwd: string) {
    return buildSandboxPolicy({
      worktree: cwd,
      tmpDir: tmpdir(),
      home: homedir(),
      hiddenScenarioDir: this.store.path('holdout'),
      gitCommonDir: this.gitCommonDir(),
      allowedHosts: this.sandboxOpt?.allowedHosts,
    });
  }

  // Once per run, before the first agent call: both probes must be blocked inside the sandbox.
  // The network probe is a deliberate outbound attempt expected to fail. Skipped when sandbox is off.
  private sandboxPreflight(): void {
    const opt = this.sandboxOpt;
    if (!opt) return;
    const exec: ProbeExec =
      this.preflightExec ??
      ((command, args, o) => {
        const r = spawnSync(command, args, { cwd: o.cwd, timeout: o.timeoutMs, encoding: 'utf8', env: scrubWorkerEnv(process.env) as NodeJS.ProcessEnv });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
      });
    const res = preflightSandbox(this.workerPolicy(this.integration.path), opt.backend, exec, {
      cwd: this.integration.path,
      docker: { image: opt.image, gvisor: opt.gvisor, network: opt.network },
    });
    for (const w of res.warnings) this.emit('log', `Sandbox pre-flight warning: ${w}`);
    if (!res.ok) throw new Error(`Sandbox pre-flight failed, refusing to dispatch workers: ${res.failures.join('; ')}`);
    this.emit('log', 'Sandbox pre-flight passed: blocked host and denied path both failed as expected');
  }

  // Sandbox and env additions for one agent call. Empty when the opt-in flags are off.
  private isolation(role: Role, cwd: string): Pick<AgentRequest, 'sandbox' | 'env'> {
    const out: Pick<AgentRequest, 'sandbox' | 'env'> = {};
    if (this.scrubEnv) out.env = scrubWorkerEnv(process.env);
    if (this.sandboxOpt && role === 'worker') {
      const policy = this.workerPolicy(cwd);
      out.sandbox = { policy, backend: this.sandboxOpt.backend, settingsDir: this.store.path('sandbox'), ...(this.sandboxOpt.backend === 'docker' ? { docker: { image: this.sandboxOpt.image, gvisor: this.sandboxOpt.gvisor, network: this.sandboxOpt.network } } : {}) };
    }
    return out;
  }

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
      ...this.isolation(role, req.cwd),
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
      toolCounts: res.toolCounts,
    });
    this.emit('agent.end', `${role}${task ? ` ${task.id}` : ''} ${res.ok ? 'finished' : `error: ${res.error}`} ($${res.costUsd.toFixed(2)}, ${Math.round(res.durationMs / 1000)}s)`, undefined, task?.id, role);
    this.save();
    return res;
  }

  private ledgerOutcome(task: Task, outcome: string, footprint?: { planned: string[]; changed: string[]; declared?: string[] }): void {
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
      ...(footprint ? { footprint } : {}),
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
// Planner-declared footprint: strings only, repo-relative normalised paths, never the state dir,
// .env* or guard-secret paths. Returns undefined when nothing usable remains.
export function sanitizeFootprint(raw: unknown): { files: string[]; symbols?: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { files?: unknown; symbols?: unknown };
  const files = new Set<string>();
  for (const f of Array.isArray(r.files) ? r.files : []) {
    if (typeof f !== 'string') continue;
    const segs = f.trim().replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
    if (!segs.length || segs.includes('..')) continue;
    const p = segs.join('/');
    if (!isExcludedPath(p)) files.add(p);
  }
  const symbols = [...new Set((Array.isArray(r.symbols) ? r.symbols : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
  if (!files.size && !symbols.length) return undefined;
  return { files: [...files], ...(symbols.length ? { symbols } : {}) };
}

export function normalizeTasks(raw: any[]): Task[] {
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const [i, r] of raw.entries()) {
    let id = String(r.id ?? `T${i + 1}`).trim() || `T${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const footprint = sanitizeFootprint(r.footprint);
    tasks.push({
      id,
      title: String(r.title ?? id),
      description: String(r.description ?? ''),
      acceptance: Array.isArray(r.acceptance) ? r.acceptance.map(String) : [],
      ...(Array.isArray(r.invariants) && r.invariants.length ? { invariants: r.invariants.map(String) } : {}),
      deps: Array.isArray(r.deps) ? r.deps.map(String) : [],
      ...(footprint ? { footprint } : {}),
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
