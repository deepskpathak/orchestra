// The conductor: deterministic code that coordinates LLM agents.
// plan -> parallel workers in worktrees -> tests + judge -> repair or merge queue -> learn.
// Planners never code, workers never judge, judges never edit (role separation).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractJson, parseWorkerOutcome, type AgentRequest, type AgentResult, type Runner } from './agent.ts';
import * as g from './git.ts';
import { alternateWorkerSection, comparePrompt, COMPARE_SCHEMA, contrastApplies, resolveContrast } from './contrast.ts';
import { aggregatePanel, lineageFraming, pairwiseBothOrders, type PanelJudgeVote } from './panel.ts';
import { isExcludedPath, loadOrBuildAtlas, type Atlas } from './atlas.ts';
import { buildTaskPack, renderMap } from './atlas-context.ts';
import { ATLAS_QUERY_HINT } from './atlas-query.ts';
import { ctagsExec } from './atlas-external.ts';
import { plannedFiles } from './exploration.ts';
import { applyContractUpdate, buildContract, contractSha, criteriaForTask, isContractPath, markPassing, unresolvedAmbiguities, type Contract } from './contracts.ts';
import { analyzeDiff, MONITOR_MARK, type IntegrityFlag } from './integrity.ts';
import { mutationScore, runMutation } from './mutation.ts';
import { listOracleFiles, runOracles, type OracleOutcome } from './oracle-run.ts';
import { loadHarness, type Harness } from './harness.ts';
import { applyLessonEdits, editsFromResponse, expireDomain, formatLearnings, listDomains, normalizeDomain, readAllLearnings, readLearnings, GLOBAL } from './learnings.ts';
import { buildSandboxPolicy, preflightSandbox, scrubVerifierEnv, scrubWorkerEnv, type ProbeExec } from './sandbox.ts';
import { newRunId, type Store } from './store.ts';
import { bisectBatch, canStart, conflictRate, decisionLog, planBatches } from './throughput.ts';
import { UNKNOWN_REQUESTER, classifyRisk, onlyHeldForApproval, runSatisfaction } from './oversight.ts';
import { bestOfNAllowed, budgetExhausted, budgetLine, cacheReadShare, planChecks, selectBestByTests, shouldEscalatePlan, type BudgetState, type TestCandidate } from './cost.ts';
import { DEFAULT_PROVIDER, resolveModel } from './models.ts';
import { resolveProvider, type ModelProvider } from './provider.ts';
import { verificationModes } from './outcomes.ts';
import { AGENTIC_INSTRUCTION, NO_EVIDENCE_NOTE, executedChecksSection, runScenarioChecks, type CheckResult } from './judge-checks.ts';
import type { ActiveAgent, CriterionResult, OrchestraEvent, PanelRecord, ProjectConfig, Role, Run, Scenario, Task, Verdict } from './types.ts';

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
  sandbox?: { backend: 'srt' | 'claude' | 'docker'; allowedHosts?: string[]; allowLocalBinding?: boolean; image?: string; gvisor?: boolean; network?: string };
  // Unattended: strip push and publish credentials from every agent env, even without a sandbox object.
  unattended?: boolean;
  // Injectable exec for the sandbox pre-flight probes (tests). Defaults to spawnSync.
  preflightExec?: ProbeExec;
  // Injectable inputs for the W4.5 mutation pass (tests). Default: files changed on the integration branch, real exec.
  mutation?: { changedFiles?: string[]; exec?: (cwd: string, command: string, timeoutMs?: number) => { ok: boolean; tail?: string } | Promise<{ ok: boolean; tail?: string }> };
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

// Only asked for when the agentic judge is on: the judge runs these commands, so they must be real and runnable.
const CHECK_BODY =
  'Give each scenario an optional "check": one shell command, run from the repository root of the finished change, that exits 0 when the scenario holds and non-zero when it does not (for example `node scripts/smoke.mjs` or a node -e one-liner). Make it deterministic, side-effect free and offline. Leave "check" out for a scenario no command can verify.';

export function plannerPrompt(i: { goal: string; files: string[]; testCommand?: string; learnings: string; domains: string[]; fastPath?: boolean; map?: string; scenarioChecks?: boolean }): BuiltPrompt {
  const body = i.scenarioChecks ? `${PLAN_BODY}\n${CHECK_BODY}` : PLAN_BODY;
  return {
    prefix: [
      `LEARNINGS:\n${i.learnings}`,
      `EXISTING DOMAINS:\n${i.domains.length ? i.domains.join('\n') : '(none yet)'}`,
      i.map ? `REPOSITORY MAP:\n${i.map}` : `REPOSITORY FILES (first ${i.files.length}):\n${i.files.join('\n')}`,
      `TEST COMMAND: ${i.testCommand ?? '(none configured)'}`,
      `GOAL:\n${i.goal}`,
    ].join('\n\n'),
    body: i.fastPath
      ? `${body}\nThis goal is small and single-concern: return exactly one task and an empty or minimal scenarios list.`
      : body,
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
  atlasQuery?: boolean; // L2: mention the atlas query command (context.atlas.query)
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
      i.atlasQuery ? ATLAS_QUERY_HINT : '',
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
  agentic?: CheckResult[]; // set (even when empty) in agentic mode (W4.2)
  indexed?: boolean; // panel mode: ask each criterion entry for its 1-based `index`, so panel votes line up by position
  atlasQuery?: boolean; // L2: mention the atlas query command (context.atlas.query)
}): BuiltPrompt {
  const { task, tests } = i;
  const base = `HIDDEN SCENARIOS for the whole goal (judge only the parts this task is responsible for):\n${i.scenarios
    .map((s) => `- ${s.id}: GIVEN ${s.given} WHEN ${s.when} THEN ${s.then}`)
    .join('\n') || '(none)'}\n\nAlso return criteria: one entry per acceptance criterion, in order, each with pass, score and a short note${i.indexed ? ', plus `index`: its 1-based position in the ACCEPTANCE CRITERIA list' : ''}.`;
  return {
    prefix: [base, guidanceSection('TOOL GUIDANCE', i.tools), guidanceSection('REVIEW CHECKLIST', i.checklist), i.agentic ? AGENTIC_INSTRUCTION : '', i.atlasQuery ? ATLAS_QUERY_HINT : ''].filter(Boolean).join('\n\n'),
    body: [
      `TASK ${task.id}: ${task.title}\n${task.description}`,
      `ACCEPTANCE CRITERIA:\n${bullets(task.acceptance)}`,
      `WORKER SUMMARY (unverified):\n${i.workerText.slice(0, 3000)}`,
      tests ? `TEST RESULT (${i.testCommand}): ${tests.ok ? 'PASSED' : 'FAILED'}\n${tests.tail}` : 'TEST RESULT: no test command configured',
      ...(i.agentic ? [executedChecksSection(i.agentic)] : []),
      `DIFF vs base:\n${i.diff}`,
    ].join('\n\n'),
  };
}

// Stand-in key for a judge that gave no usable per-criterion answers. It is never tallied once any judge keyed real criteria.
export const OVERALL = 'overall';

const normText = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// One stable, unique label per acceptance criterion (the text; later duplicates get a "(#n)" suffix).
export function criterionLabels(acceptance: string[]): string[] {
  const seen = new Map<string, number>();
  return acceptance.map((a) => {
    const n = (seen.get(a) ?? 0) + 1;
    seen.set(a, n);
    return n === 1 ? a : `${a} (#${n})`;
  });
}

type SlotCriterion = CriterionResult & { scored: boolean }; // scored: the judge gave a finite score

// Maps a judge's criteria onto acceptance slots (0-based). In order of trust: the judge's own 1-based `index`, then
// the normalised criterion text, then position when the count matches. Anything still unmatched is dropped, so two
// judges can never end up with disjoint keys that each look like a lone vote.
export function matchCriteria(raw: unknown, acceptance: string[]): Map<number, SlotCriterion> {
  const entries = (Array.isArray(raw) ? raw : []).flatMap((c: any) => {
    const n = normalizeCriterion(c);
    return n ? [{ n: { ...n, scored: Number.isFinite(c.score) }, index: Number.isInteger(c.index) ? (c.index as number) : undefined }] : [];
  });
  const slots = new Map<number, SlotCriterion>();
  const byIndex = entries.map((e, pos) => ({ ...e, pos }));
  const afterIndex = byIndex.filter((e) => {
    const k = e.index === undefined ? -1 : e.index - 1;
    if (k >= 0 && k < acceptance.length && !slots.has(k)) {
      slots.set(k, e.n);
      return false;
    }
    return true;
  });
  const texts = acceptance.map(normText);
  const afterText = afterIndex.filter((e) => {
    const t = normText(e.n.criterion);
    const k = t ? texts.findIndex((x, i) => x === t && !slots.has(i)) : -1;
    if (k >= 0) slots.set(k, e.n);
    return k < 0;
  });
  if (entries.length === acceptance.length) for (const e of afterText) if (!slots.has(e.pos)) slots.set(e.pos, e.n);
  return slots;
}

// One judge's per-criterion binary verdicts keyed by acceptance label. A judge with no matchable criteria
// contributes a single synthetic `overall` verdict instead.
export function panelCriteria(v: Partial<Verdict>, acceptance: string[]): Record<string, boolean> {
  const slots = matchCriteria(v.criteria, acceptance);
  if (!slots.size) return { [OVERALL]: Boolean(v.pass) };
  const labels = criterionLabels(acceptance);
  return Object.fromEntries([...slots].sort(([a], [b]) => a - b).map(([k, c]) => [labels[k], c.pass]));
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// Clear-majority panel verdict: per-criterion majority, mean scores, issues from every judge. Non-finite scores are ignored.
export function panelMajorityVerdict(raws: Partial<Verdict>[], majority: Record<string, boolean>, acceptance: string[]): Partial<Verdict> {
  const real = Object.keys(majority).filter((k) => k !== OVERALL);
  const passVotes = raws.filter((x) => x.pass).length;
  const finite = raws.map((r) => Number(r.score)).filter(Number.isFinite);
  const score = finite.length ? mean(finite) : passVotes * 2 > raws.length ? 1 : 0;
  const issues = [...new Set(raws.flatMap((r) => r.issues ?? []))];
  const lead = raws.find((r) => r.pass === (passVotes * 2 > raws.length)) ?? raws[0];
  const labels = criterionLabels(acceptance);
  const slotsOf = raws.map((r) => matchCriteria(r.criteria, acceptance));
  const perCriterion = real.length ? real.map((criterion) => {
    const found = slotsOf.flatMap((m) => {
      const c = m.get(labels.indexOf(criterion));
      return c ? [c] : [];
    });
    const scores = found.filter((c) => c.scored).map((c) => c.score);
    // W4.2 + W4.1: keep the evidence of the first judge that sided with the majority, so agentic mode can still see it.
    const evidence = found.find((c) => c.pass === majority[criterion] && c.evidence)?.evidence;
    return { criterion, pass: majority[criterion], score: scores.length ? mean(scores) : majority[criterion] ? 1 : 0, ...(evidence ? { evidence } : {}) };
  }) : undefined;
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
        properties: { id: { type: 'string' }, given: { type: 'string' }, when: { type: 'string' }, then: { type: 'string' }, check: { type: 'string' } },
        required: ['id', 'given', 'when', 'then'],
      },
    },
  },
  required: ['tasks', 'scenarios'],
};

// W6.3: the cascade draft also reports how sure it is; the strong planner call never sees this field.
const CONFIDENCE_ASK = 'Also return a numeric top-level "confidence" from 0 to 1: how sure you are that this plan is complete, correctly ordered and has testable acceptance criteria.';
const withConfidence = (schema: any) => ({ ...schema, properties: { ...schema.properties, confidence: { type: 'number', minimum: 0, maximum: 1 } } });

export const FAST_PLAN_SCHEMA = {
  ...PLAN_SCHEMA,
  properties: { ...PLAN_SCHEMA.properties, tasks: { ...PLAN_SCHEMA.properties.tasks, maxItems: 1 } },
  required: ['tasks'],
};

// A well-formed criterion entry with its score clamped to 0..1 (non-finite scores become 0); null for anything malformed.
function normalizeCriterion(c: any): CriterionResult | null {
  if (!c || typeof c !== 'object' || typeof c.criterion !== 'string' || typeof c.pass !== 'boolean') return null;
  const n = Number.isFinite(c.score) ? Math.min(1, Math.max(0, c.score)) : 0;
  return { criterion: c.criterion, pass: c.pass, score: n, ...(typeof c.note === 'string' ? { note: c.note } : {}), ...(typeof c.evidence === 'string' && c.evidence.trim() ? { evidence: c.evidence } : {}) };
}

// Per-criterion judging: mean score, and pass only when every criterion passes. Malformed entries are skipped.
// In agentic mode, `unevidenced` lists criteria that passed without evidence (advisory only).
export function aggregateCriteria(criteria: unknown, agentic = false): { score: number; pass: boolean; failing: CriterionResult[]; list: CriterionResult[]; unevidenced: CriterionResult[] } | undefined {
  if (!Array.isArray(criteria)) return undefined;
  const list: CriterionResult[] = [];
  for (const c of criteria) {
    const n = normalizeCriterion(c);
    if (n) list.push(n);
  }
  if (!list.length) return undefined;
  return { score: list.reduce((a, c) => a + c.score, 0) / list.length, pass: list.every((c) => c.pass), failing: list.filter((c) => !c.pass), list, unevidenced: agentic ? list.filter((c) => c.pass && !c.evidence) : [] };
}

// Combines the judge's raw verdict with test results and per-criterion results (when given).
export function buildVerdict(v: Partial<Verdict>, testsOk: boolean | null, passThreshold: number, testIssue?: string, agentic = false): Verdict {
  const agg = aggregateCriteria(v.criteria, agentic);
  const score = agg ? agg.score : (v.score as number);
  const pass = Boolean(v.pass) && score >= passThreshold && testsOk !== false && (agg?.pass ?? true);
  const issues = [...(v.issues ?? [])];
  if (agg) issues.unshift(...agg.failing.map((c) => `Criterion failed: ${c.criterion}${c.note ? `: ${c.note}` : ''}`));
  if (agg?.unevidenced.length) issues.push(...agg.unevidenced.map((c) => `${NO_EVIDENCE_NOTE}: ${c.criterion}`));
  if (testsOk === false && testIssue) issues.unshift(testIssue);
  return { pass, score: round(score), summary: v.summary ?? '', issues, testsPassed: testsOk, ...(agg ? { criteria: agg.list } : {}) };
}

export function oraclePrompt(i: { task: Task; invariants: string[]; target: string; dir: string }): string {
  return [
    `ORACLE TESTS for task ${i.task.id}: ${i.task.title}`,
    'You write independent checks. You did not write the code under test and must not edit it.',
    `Acceptance criteria:\n${bullets(i.task.acceptance)}`,
    `Invariants to check:\n${bullets(i.invariants)}`,
    `The code under test is at ${i.target} (read only). The environment variable ORACLE_TARGET holds that path when your files run; import code from it.`,
    `Write files only inside ${i.dir}:`,
    '- *.test.mjs: node:test files with property-style checks. Use process.env.ORACLE_SEED and process.env.ORACLE_RUNS for a deterministic seed and case count.',
    '- probe*.mjs: scripts that print the output of functions that must NOT change. They run on the base commit and on the worker tree and their stdout must match.',
  ].join('\n\n');
}

export function applyOracle(v: Verdict, o: OracleOutcome): Verdict {
  if (o.pass) return o.issues.length ? { ...v, issues: [...v.issues, ...o.issues] } : v;
  return { ...v, pass: false, summary: `Oracle checks failed. ${v.summary}`.trim(), issues: [...o.issues, ...v.issues] };
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
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, score: { type: 'number', minimum: 0, maximum: 1 }, note: { type: 'string' }, evidence: { type: 'string' } },
        required: ['criterion', 'pass', 'score'],
      },
    },
  },
  required: ['pass', 'score', 'summary', 'issues'],
};

// Panel judges also number their criteria so votes can be matched by position, not by free text.
const PANEL_VERDICT_SCHEMA = {
  ...VERDICT_SCHEMA,
  properties: {
    ...VERDICT_SCHEMA.properties,
    criteria: { ...VERDICT_SCHEMA.properties.criteria, items: { ...VERDICT_SCHEMA.properties.criteria.items, properties: { ...VERDICT_SCHEMA.properties.criteria.items.properties, index: { type: 'integer', minimum: 1 } } } },
  },
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

type AgentVariant = NonNullable<NonNullable<AgentRequest['meta']>['variant']>;

export class Conductor {
  readonly run: Run;
  private readonly store: Store;
  private readonly provider: ModelProvider; // W8.1: every agent call goes through the adapter
  private readonly sandboxOpt?: ConductorOptions['sandbox'];
  private readonly scrubEnv: boolean;
  private readonly preflightExec?: ProbeExec;
  private readonly harness: Harness;
  private readonly onUpdate?: (run: Run) => void;
  private scenarios: Scenario[] = [];
  private mutationOpts?: ConductorOptions['mutation'];
  private contract?: Contract; // W4.3: the conductor's own copy of the contract; the file under .orchestra is checked against it
  private atlas?: Atlas;
  private map = '';
  private ablate: Ablation;
  private evalLearnings: boolean;
  private integration!: { path: string; branch: string; base: string };
  private mergeChain: Promise<unknown> = Promise.resolve();
  // Last integration commit whose tests passed. Batch merging parks transient and rejected merge states on
  // the integration worktree while tests run, so new task worktrees branch from this commit, never from HEAD.
  private knownGood = '';
  private readonly inflight = new Map<string, Promise<void>>(); // tasks with an attempt in progress (scheduler)
  private readonly cfg: ProjectConfig; // snapshot taken at construction for the per-call hot paths (call, budgets, batch flush, atlas hint)
  private batchQueue: { task: Task; resolve: () => void }[] = []; // W6.2: judged-pass tasks waiting for a batch
  private readonly mergeReadyAt = new Map<string, number>();
  private readonly workerUse = new Map<string, { turns: number; usd: number }>(); // W6.5: worker turns and dollars per task, all attempts
  private cacheWarmed = false; // W6.4: the first worker has started acting, so its prompt prefix is cached
  private wakeScheduler: () => void = () => {};
  private readonly warmSignal = new Promise<void>((r) => { this.wakeScheduler = r; });
  private readonly wtRoot: string;

  // `existing` resumes a stored run in place (see resume()); otherwise a new run is created.
  constructor(opts: ConductorOptions, existing?: Run) {
    this.store = opts.store;
    this.cfg = opts.store.config();
    this.provider = resolveProvider(this.cfg.provider, opts.runner);
    this.harness = loadHarness(opts.store, opts.harnessVersion);
    this.onUpdate = opts.onUpdate;
    this.sandboxOpt = opts.sandbox;
    this.preflightExec = opts.preflightExec;
    this.mutationOpts = opts.mutation;
    this.scrubEnv = Boolean(opts.sandbox || opts.unattended);
    this.ablate = opts.ablate ?? {};
    this.evalLearnings = opts.evalLearnings ?? false;
    this.wtRoot = opts.store.path('worktrees');
    if (existing) {
      this.run = existing;
      return;
    }
    const id = (opts.kind === 'eval' ? 'e' : '') + newRunId();
    const modes = verificationModes(this.cfg.verification);
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
      requestedBy: detectRequester(opts.store.root),
      ...(modes.length ? { verificationModes: modes } : {}),
    };
  }

  // ---------- public ----------

  async execute(): Promise<Run> {
    const { run, store } = this;
    return this.guarded(async () => {
      g.assertRepo(store.root);
      g.excludeOrchestra(store.root);
      this.integration = g.createIntegration(store.root, this.wtRoot, run.id, run.baseRef);
      run.integrationBranch = this.integration.branch;
      run.baseRef = this.integration.base;
      this.knownGood = this.integration.base;
      this.emit('run.start', `Run started: ${run.goal}`, { harness: run.harness });
      this.save();

      this.sandboxPreflight();
      await this.plan();
      run.status = 'running';
      this.save();
      await this.complete();
    });
  }

  // W7.1: finish a run that approval finalised with work deferred (run.deferred). Same run id and integration
  // branch: reopen the branch tip, reload what plan() stored (hidden scenarios, contract, atlas), make the tasks
  // that were blocked only behind held-then-merged tasks runnable again, then run the shared tail. Call
  // assertResumable() first; resumeRun() does.
  async resume(): Promise<Run> {
    const { run, store } = this;
    // Setup touches nothing in the stored run: a failure here (branch checked out elsewhere, contract mismatch,
    // pre-flight) throws to the caller and leaves the run file as it was.
    try {
      g.assertRepo(store.root);
      this.integration = g.reopenIntegration(store.root, this.wtRoot, run.id, run.integrationBranch!, run.baseRef!);
      this.knownGood = g.head(this.integration.path);
      this.reloadPlan();
      this.sandboxPreflight();
    } catch (e) {
      if (this.integration) g.removeWorktree(store.root, this.integration.path);
      throw e;
    }
    return this.guarded(async () => {
      const recovered = this.recoverInFlight();
      const reset = this.unblockResumable();
      const deferred = run.deferred ?? [];
      run.status = 'running';
      delete run.error;
      this.emit('log', `Run resumed after approval (deferred: ${deferred.join(', ') || 'none'})${reset.length ? `; running ${reset.join(', ')}` : '; no tasks to run'}${recovered.length ? `; recovered ${recovered.join(', ')} from an interrupted resume` : ''}`, { deferred, reset, recovered });
      this.save();
      // The marker decides, not today's config: mutation only if the run started with it, learning only if owed.
      await this.complete({ mutation: deferred.includes('mutation') ? 'always' : 'never', learning: deferred.includes('learning') });
      // Cleared only once the tail finished: a resume that throws or is killed keeps the marker and can be retried.
      delete run.deferred;
    });
  }

  // The planner's outputs that later phases read, as plan() stored them. The contract must still verify.
  private reloadPlan(): void {
    const { run, store } = this;
    this.scenarios = store.readJson<Scenario[]>(`holdout/${run.id}.json`, []);
    if (run.contract) {
      const contract = store.readJson<Contract>(run.contract.path, { criteria: [] });
      if (contractSha(contract) !== run.contract.sha256) throw new Error(`acceptance contract ${run.contract.path} does not match its recorded sha256; refusing to resume`);
      this.contract = contract;
    }
    this.loadAtlas();
  }

  // A resume that died mid-run (crash, Ctrl-C) leaves tasks in flight. A merge that reached the integration branch
  // counts as merged; any other in-flight task restarts on a clean worktree from the integration tip.
  private recoverInFlight(): string[] {
    const { store } = this;
    const recovered: string[] = [];
    for (const t of this.run.tasks) {
      if (t.status !== 'running' && t.status !== 'judging' && t.status !== 'merging') continue;
      recovered.push(t.id);
      if (t.status === 'merging' && t.branch && g.tryGit(store.root, 'merge-base', '--is-ancestor', t.branch, this.integration.branch).ok) {
        t.status = 'merged';
        t.endedAt ??= Date.now();
        continue;
      }
      if (t.worktree) g.removeWorktree(store.root, t.worktree);
      if (t.branch) g.deleteBranch(store.root, t.branch);
      delete t.worktree;
      delete t.branch;
      t.status = 'pending';
    }
    return recovered;
  }

  // Blocked tasks whose dependency chain ends only in merged tasks go back to pending. A task behind a failed or
  // needs_human task stays blocked.
  private unblockResumable(): string[] {
    const dead = new Map<string, boolean>();
    const isDead = (t: Task | undefined): boolean => {
      if (!t) return false;
      const known = dead.get(t.id);
      if (known !== undefined) return known;
      dead.set(t.id, false); // normalizeTasks breaks cycles; this guards a hand-edited run file
      const d = t.status === 'failed' || t.status === 'needs_human' || t.status === 'awaiting_approval' || (t.status === 'blocked' && t.deps.some((x) => isDead(this.task(x))));
      dead.set(t.id, d);
      return d;
    };
    const reset: string[] = [];
    for (const t of this.run.tasks) {
      if (t.status === 'blocked' && !isDead(t)) {
        t.status = 'pending';
        reset.push(t.id);
      }
    }
    return reset;
  }

  // Runs `body`, records any error as a failed run, and always finalises (cleanup, run metrics, run.end).
  private async guarded(body: () => Promise<void>): Promise<Run> {
    const { run } = this;
    try {
      await body();
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;
      this.emit('log', `Run aborted: ${run.error}`);
    } finally {
      run.endedAt = Date.now();
      run.active = [];
      this.cleanup();
      const rows = this.store.ledgerRows().filter((r) => r.run === run.id);
      run.conflictRate = round(conflictRate(rows));
      const share = cacheReadShare(rows);
      if (share !== undefined) run.cacheReadShare = round(share);
      this.emit('run.end', `Run ${run.status}. satisfaction ${run.satisfaction ?? 0}, cost $${run.costUsd.toFixed(2)}`, {
        satisfaction: run.satisfaction,
        conflictRate: run.conflictRate,
        ...(run.cacheReadShare !== undefined ? { cacheReadShare: run.cacheReadShare } : {}),
        branch: run.integrationBranch,
      });
      this.save();
    }
    return run;
  }

  // The post-plan tail shared by execute() and resume(): schedule, approval hold, mutation, satisfaction,
  // learning and the final status. `work` defaults to a fresh run's: mutation as configured, learning for goal runs.
  private async complete(work: { mutation: 'config' | 'always' | 'never'; learning: boolean } = { mutation: 'config', learning: this.run.kind === 'goal' }): Promise<void> {
    const { run } = this;
    await this.schedule();
    if (onlyHeldForApproval(run.tasks)) {
      // W7.1: the run is waiting on a human, not failed. Satisfaction, mutation and learning describe the whole
      // run, so they wait for `orchestra approve` (which finalises satisfaction and status; see src/approve.ts).
      run.status = 'awaiting_approval';
      const held = run.tasks.filter((t) => t.status === 'awaiting_approval').map((t) => t.id);
      this.emit('log', `Run waits for approval of ${held.join(', ')}; satisfaction, mutation score and learning are deferred`, { held });
      return;
    }
    const mutationFailure = work.mutation === 'never' ? undefined : await this.mutationPass(work.mutation === 'always');

    const merged = run.tasks.filter((t) => t.status === 'merged');
    run.satisfaction = runSatisfaction(run.tasks);

    if (work.learning) {
      run.status = 'compounding';
      this.save();
      await this.learn();
    }
    run.status = merged.length === run.tasks.length && !mutationFailure ? 'done' : 'failed';
    if (mutationFailure && !run.error) run.error = mutationFailure;
    if (run.status === 'failed' && !run.error) {
      const human = run.tasks.filter((t) => t.status === 'needs_human').length;
      const blocked = run.tasks.filter((t) => t.status === 'blocked').length;
      const awaiting = run.tasks.filter((t) => t.status === 'awaiting_approval').length;
      const failed = run.tasks.length - merged.length - human - blocked - awaiting;
      run.error = `${run.tasks.length - merged.length} of ${run.tasks.length} tasks did not land (${failed} failed, ${blocked} blocked, ${human} need a human${awaiting ? `, ${awaiting} awaiting approval` : ''})`;
    }
  }

  // ---------- phases ----------

  // W4.5: mutate the source files this run changed, in a scratch worktree, and see whether the test
  // command and scenario checks notice. Returns an error message only when failBelowFloor trips. `force` runs it
  // even if mutation is now off in the config (a resumed run that started with it).
  private async mutationPass(force = false): Promise<string | undefined> {
    const { run, store } = this;
    const cfg = store.config().verification.mutation;
    if ((!cfg.enabled && !force) || !run.tasks.some((t) => t.status === 'merged')) return undefined;
    const testCommand = store.config().testCommand;
    let wt: { path: string; branch: string } | undefined;
    try {
      const changed = this.mutationOpts?.changedFiles ?? g.changedFiles(this.integration.path, this.integration.base, false);
      const files = changed.filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f) && !/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(f));
      wt = g.createTaskWorktree(store.root, this.wtRoot, run.id, 'mutation', this.knownGood);
      const cwd = wt.path;
      const exec = this.mutationOpts?.exec ?? ((d: string, c: string, t?: number) => g.runTestsAsync(d, c, t, scrubVerifierEnv(process.env)));
      const out = await runMutation({
        files,
        max: cfg.maxMutants,
        commands: [...(testCommand ? [testCommand] : []), ...this.scenarios.flatMap((s) => (s.check ? [s.check] : []))],
        read: (f) => readFileSync(join(cwd, f), 'utf8'),
        write: (f, c) => writeFileSync(join(cwd, f), c),
        exec: (c, t) => exec(cwd, c, t),
        mutantTimeoutMs: cfg.mutantTimeoutMs,
      });
      if (out.unreadable) this.emit('log', `Mutation left out ${out.unreadable.length} unreadable file(s): ${out.unreadable.join(', ')}`);
      // A skipped pass (no checks, failing baseline, nothing to mutate) has no score. Recording a vacuous
      // 1.0 pass would read as evidence the tests are strong, so record it as skipped and never gate on it.
      const m = mutationScore(out.results, cfg.floor);
      const skipped = out.skipped ?? (out.results.length === 0 ? 'no mutable source changes' : m.total === 0 ? 'every mutant failed to compile' : undefined);
      if (skipped) {
        run.mutation = { total: 0, killed: 0, floor: cfg.floor, skipped };
        this.emit('log', `Mutation skipped: ${skipped}`, { mutation: run.mutation });
        this.save();
        return undefined;
      }
      run.mutation = { total: m.total, killed: m.killed, score: m.score, floor: m.floor, pass: m.pass, ...(m.invalid ? { invalid: m.invalid } : {}) };
      this.emit('log', `Mutation score ${m.score.toFixed(2)} (${m.killed}/${m.total} killed, floor ${m.floor}${m.invalid ? `, ${m.invalid} invalid mutant(s) excluded` : ''}) ${m.pass ? 'pass' : 'below floor'}`, { mutation: run.mutation });
      this.save();
      if (!m.pass && cfg.failBelowFloor) return `Mutation score ${m.score.toFixed(2)} is below the floor ${m.floor} (${m.survived} of ${m.total} mutants survived)`;
    } catch (e) {
      this.emit('log', `Mutation pass failed, continuing without a score: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      if (wt) {
        g.removeWorktree(store.root, wt.path);
        g.deleteBranch(store.root, wt.branch);
      }
    }
    return undefined;
  }

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
      scenarioChecks: cfg.verification.agenticJudge.enabled,
    });
    const prompt = joinPrompt(built);

    const schema = fp.fast ? FAST_PLAN_SCHEMA : PLAN_SCHEMA;
    const ask = (attempt: number, model?: string, draft = false) =>
      this.call('planner', undefined, attempt, {
        prompt: draft ? `${prompt}\n\n${CONFIDENCE_ASK}` : prompt,
        cwd: this.integration.path,
        schema: draft ? withConfidence(schema) : schema,
        tools: ['Read', 'Grep', 'Glob'],
      }, model);
    let res: AgentResult;
    const cascade = cfg.planner?.cascade;
    if (cascade?.enabled) {
      // W6.3: a cheap model drafts; the harness planner model is called only when the draft is unsure or fails a deterministic check.
      const draftModel = resolveModel(cascade.draftModel, harness.config.provider ?? DEFAULT_PROVIDER);
      const draft = await ask(1, draftModel, true);
      const dOut = draft.ok ? (extractJson(draft) as { tasks?: any[]; confidence?: unknown } | undefined) : undefined;
      const issues = !draft.ok ? [`draft planner failed: ${draft.error}`] : dOut?.tasks?.length ? planChecks(dOut.tasks) : ['draft plan has no tasks'];
      const confidence = typeof dOut?.confidence === 'number' ? dOut.confidence : undefined;
      const decision = shouldEscalatePlan({ confidence, threshold: cascade.confidenceThreshold, issues });
      this.emit('log', `Planner cascade: ${decision.escalate ? 'escalated to' : 'accepted draft from'} ${decision.escalate ? harness.config.models.planner : draftModel} (${decision.reason})`, { cascade: { draftModel, confidence, escalated: decision.escalate, reason: decision.reason } });
      // Outcome row for a later router: one per run, scored with the draft's confidence.
      this.store.ledger({ t: Date.now(), run: run.id, kind: run.kind, harness: harness.version, role: 'planner', attempt: 1, model: draftModel, ok: !decision.escalate, costUsd: 0, durationMs: 0, turns: 0, outcome: decision.escalate ? 'plan_cascade_escalated' : 'plan_cascade_draft_accepted', ...(confidence !== undefined ? { score: confidence } : {}) });
      res = decision.escalate ? await ask(2) : draft;
    } else {
      res = await ask(1);
    }
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
      this.contract = contract;
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
  // L2: the query command is only mentioned when the atlas is loaded and context.atlas.query is on.
  private atlasQuery(): boolean {
    return !!this.atlas && !!this.cfg.context.atlas.query;
  }

  private loadAtlas(): void {
    const cfg = this.store.config().context.atlas;
    if (!cfg.enabled) return;
    try {
      this.atlas = loadOrBuildAtlas(this.store.root, this.integration.base, { mode: cfg.external ?? 'off', exec: ctagsExec, log: (m) => this.emit('log', m) });
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
    const { run, inflight } = this;
    const cfg = this.store.config();

    for (;;) {
      if (run.costUsd >= cfg.runBudgetUsd) {
        for (const t of run.tasks) {
          if (t.status === 'pending' || t.status === 'repair') this.fail(t, `run budget $${cfg.runBudgetUsd} exhausted`);
        }
      }
      const ready = run.tasks.filter(
        (t) => (t.status === 'pending' || t.status === 'repair') && !inflight.has(t.id) && t.deps.every((d) => this.task(d)?.status === 'merged'),
      );
      // W6.1 single writer: a task with an overlapping footprint waits for the in-flight one to finish.
      const running = run.tasks.filter((t) => inflight.has(t.id));
      let slots = Math.max(0, cfg.concurrency - inflight.size);
      // W6.4: start one worker and let it begin acting (cache warm) before the siblings fan out.
      const warming = cfg.cache?.discipline.enabled && cfg.cache.discipline.warmFirst && !this.cacheWarmed;
      if (warming && inflight.size > 0) slots = 0;
      else if (warming) slots = Math.min(slots, 1);
      for (const t of ready) {
        if (slots <= 0) break;
        if (cfg.throughput?.footprintScheduling && !canStart(t, running)) continue;
        slots--;
        running.push(t);
        const p = this.attempt(t)
          .catch((err) => this.fail(t, `internal error: ${(err as Error).message}`))
          .finally(() => {
            this.warmed();
            inflight.delete(t.id);
            this.pokeBatch();
          });
        inflight.set(t.id, p);
      }
      if (inflight.size === 0) break;
      await Promise.race(warming && !this.cacheWarmed ? [...inflight.values(), this.warmSignal] : inflight.values());
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
    const wt = g.createTaskWorktree(store.root, this.wtRoot, this.run.id, task.id, this.knownGood);
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
    const depLog = (cfg.throughput?.decisionLog ?? cfg.throughput?.footprintScheduling) ? decisionLog(task.deps.map((d) => this.task(d)).filter((d): d is Task => d?.status === 'merged')) : '';
    const prompt = joinPrompt(
      workerPrompt({
        goal: this.run.goal,
        learnings: formatLearnings(learnings, 'worker', this.run.domain, undefined, {
          // Cache discipline: the same prefix for every sibling, so no per-task lesson ordering.
          footprint: cfg.cache?.discipline.enabled ? [] : (task.footprint?.files ?? []),
          graph: cfg.learnings?.graph === true,
          // Eval trials that read the store (the with-lessons ablation arm) still get no code-linked boost.
          cleanRoom: this.run.kind === 'eval',
        }),
        testCommand: cfg.testCommand,
        task,
        others,
        progressFile: task.notes.length ? store.path(progressRel(this.run.id, task.id)) : undefined,
        tools: harness.guidance.tools,
        style: harness.guidance.style,
        map: this.map || undefined,
        pack: this.taskPack(task),
        atlasQuery: this.atlasQuery(),
      }),
    ) + (depLog ? `\n\n## Decisions from merged dependencies\n${depLog}` : '')
      + (cfg.budgets?.workerPrompt.enabled ? `\n\n## Budget\n${budgetLine(this.budgetState(task))}` : '');

    if (!this.ablate.contrastive && contrastApplies(cfg, task)) return this.attemptContrast(task, wt, base, prompt);

    // W6.4: identical tool lists across siblings, whatever order the config listed them in.
    const common = { allowedTools: cfg.cache?.discipline.enabled ? [...cfg.allowedTools].sort() : cfg.allowedTools, disallowedTools: cfg.disallowedTools, permissionMode: cfg.permissionMode };
    // W6.6: extra samples only where an executable verifier exists.
    const verifier = !!cfg.testCommand || this.scenarios.some((s) => !!s.check?.trim());
    const n = cfg.bestOfN?.enabled ? bestOfNAllowed({ n: cfg.bestOfN.n, hasExecutableVerifier: verifier }) : 1;
    if (cfg.bestOfN?.enabled && n === 1 && !verifier) this.emit('log', `${task.id} best-of-n skipped: no test command or scenario check to select with`, undefined, task.id);
    const work = n > 1
      ? await this.sampleBest(task, wt, base, n, prompt, common)
      : await this.call('worker', task, task.attempts, { prompt, cwd: wt.path, ...common });
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
    // W6.5 hard cap: out of worker turns or dollars means no further attempt, whatever attempts remain.
    if (!verdict.pass && cfg.budgets?.workerPrompt.enabled && budgetExhausted(this.budgetState(task))) {
      this.ledgerOutcome(task, 'budget_cap');
      const b = this.budgetState(task);
      return this.fail(task, `worker budget cap reached (${b.turnsUsed}/${b.maxTurns} turns, $${b.usdSpent.toFixed(2)}/$${b.usdCap.toFixed(2)}). Last issues: ${verdict.issues.join(' | ').slice(0, 200)}`);
    }
    if (!verdict.pass) return this.repairOrFail(task, verdict.issues.length ? verdict.issues : [verdict.summary]);

    task.status = 'merging';
    this.save();
    await this.land(task);
  }

  // Integrity monitor: analyze the worker's diff and persist the flags. When tests or other grading
  // files were tampered with, re-run the test command with the base versions restored and grade on
  // that. Returns a failing verdict (with an automatic repair note) in that case, else null.
  private integrityVerdict(task: Task, cwd: string, base: string): Verdict | null {
    const broken = this.contractVerdict(task, cwd, base);
    if (broken) return broken;
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

  // W4.3: the contract file lives under .orchestra, outside every worktree, so a worktree diff cannot show an
  // edit to it. Re-verify its sha256 against the value recorded at planning (and against the worker's changed
  // paths, for repos that track .orchestra). A mismatch fails the attempt like any grading-surface edit, and the
  // file is rewritten from the conductor's copy so later reads (judge, oracles) see the frozen contract.
  private contractVerdict(task: Task, cwd: string, base: string): Verdict | null {
    const ref = this.run.contract;
    if (!ref || !this.contract) return null;
    let actual: string;
    try {
      actual = contractSha(this.store.readJson<Contract>(ref.path, { criteria: [] }));
    } catch {
      actual = 'unreadable';
    }
    const touched = g.changedFiles(cwd, base).filter(isContractPath);
    if (actual === ref.sha256 && !touched.length) return null;
    const detail = actual === ref.sha256 ? `the worker diff touches ${touched.join(', ')}` : `sha256 ${actual.slice(0, 12)} does not match the recorded ${ref.sha256.slice(0, 12)}`;
    this.store.writeJson(ref.path, this.contract);
    task.integrityFlags = [...(task.integrityFlags ?? []), { kind: 'grading-surface', file: ref.path, detail: `acceptance contract modified: ${detail}` }];
    this.emit('log', `${task.id} integrity monitor: acceptance contract ${detail}; contract restored`, undefined, task.id);
    this.ledgerOutcome(task, 'integrity_flag');
    const issue = `${MONITOR_MARK} The acceptance contract is frozen and was modified (${detail}). It has been restored. Do not edit anything under .orchestra; implement the task against the stated criteria instead.`;
    return { pass: false, score: 0, summary: `${MONITOR_MARK} acceptance contract modified`, issues: [issue], testsPassed: null };
  }

  // The task's acceptance text and invariants as frozen in the verified contract file; null when contracts are
  // off or the file does not verify, in which case callers use the in-memory plan (the tamper is flagged elsewhere).
  private frozenCriteria(task: Task): { acceptance: string[]; invariants: string[] } | null {
    const ref = this.run.contract;
    if (!ref) return null;
    try {
      const onDisk = this.store.readJson<Contract>(ref.path, { criteria: [] });
      if (contractSha(onDisk) !== ref.sha256) return null;
      const own = criteriaForTask(onDisk, task.id);
      return own.acceptance.length ? own : null;
    } catch {
      return null;
    }
  }

  // Merged means every criterion of the task passed judging. Flip them failing -> passing in the contract,
  // through the same validator that guards worker proposals, then record the new sha256.
  private markCriteriaPassing(task: Task): void {
    const ref = this.run.contract;
    if (!ref || !this.contract) return;
    try {
      const results = task.verdict?.criteria;
      let next = this.contract;
      task.acceptance.forEach((_, i) => {
        const res = results && results.length === task.acceptance.length ? results[i] : undefined;
        if (!res || res.pass) next = markPassing(next, `${task.id}.c${i + 1}`);
      });
      const checked = applyContractUpdate(this.contract, next);
      if (!checked.ok) throw new Error(checked.errors.join('; '));
      this.contract = checked.contract;
      this.store.writeJson(ref.path, this.contract);
      ref.sha256 = contractSha(this.contract);
    } catch (e) {
      this.emit('log', `${task.id} contract update failed: ${(e as Error).message.split('\n')[0]}`, undefined, task.id);
    }
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
    const wtB = g.createTaskWorktree(store.root, this.wtRoot, this.run.id, idB, this.knownGood);
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
    await this.land(task);
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
    const agentic = cfg.verification.agenticJudge.enabled ? cfg.verification.agenticJudge : undefined;
    const panelOn = cfg.verification.panel.enabled && cfg.verification.panel.judges.length > 0;
    const headBefore = g.head(cwd);
    const frozen = this.frozenCriteria(task);
    const built = judgePrompt({
        task: frozen ? { ...task, acceptance: frozen.acceptance } : task,
        scenarios: this.scenarios,
        workerText: work.text,
        testCommand: cfg.testCommand,
        tests,
        diff: g.diffSince(cwd, base),
        tools: this.harness.guidance.tools,
        checklist: this.harness.guidance.checklist,
        indexed: panelOn,
        atlasQuery: this.atlasQuery(),
        agentic: agentic ? await runScenarioChecks({ cwd, scenarios: this.scenarios, testCommand: cfg.testCommand, testsResult: tests, timeoutMs: agentic.checkTimeoutMs, exec: (d, c, t) => g.runTestsAsync(d, c, t, scrubVerifierEnv(process.env)) }) : undefined,
      });
    const prompt = joinPrompt(built);
    const oracle = await this.oraclePass(task, cwd, base, frozen?.invariants);

    const testsOk = tests ? tests.ok : null;
    const runJudge = async (model?: string, framing = ''): Promise<{ res: AgentResult; v?: Partial<Verdict> }> => {
      const res = await this.call(
        'judge',
        task,
        task.attempts,
        {
          prompt: framing ? joinPrompt({ ...built, prefix: `${framing}\n\n${built.prefix}` }) : prompt,
          cwd,
          schema: panelOn ? PANEL_VERDICT_SCHEMA : VERDICT_SCHEMA,
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
    if (panelOn) {
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
        // The synthetic `overall` answer of a judge without usable criteria is only tallied when no judge keyed real
        // criteria; and every acceptance criterion must be decided by a true majority of the judges.
        const keyed = votes.some((vt) => Object.keys(vt.criteria).some((k) => k !== OVERALL));
        const tallied = keyed ? votes.map((vt) => ({ ...vt, criteria: Object.fromEntries(Object.entries(vt.criteria).filter(([k]) => k !== OVERALL)) })) : votes;
        const agg = aggregatePanel(tallied, keyed ? criterionLabels(task.acceptance) : []);
        const escalated = agg.split;
        panel = {
          votes: votes.map((vote, i) => ({ judge: vote.judge, model: vote.model, lineage: vote.lineage, pass: Boolean(raws[i].pass), score: Number.isFinite(Number(raws[i].score)) ? Number(raws[i].score) : 0, criteria: vote.criteria })),
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
    const verdict = buildVerdict(v, testsOk, this.harness.config.passThreshold, testsOk === false ? `Test command \`${cfg.testCommand}\` fails. Output tail:\n${tests!.tail.slice(-1200)}` : undefined, Boolean(agentic));
    const withOracle = oracle ? applyOracle(verdict, oracle) : verdict;
    return panel ? { ...withOracle, panel } : withOracle;
  }

  // W4.4 (opt-in): oracle tests written by a separate session into a run-owned directory outside the
  // worker worktree, then executed against the worker's tree. Returns null when oracles do not apply.
  // Any failure here (git worktree add, mkdir, a missing base ref) is logged and degrades to no oracle
  // evidence, the same way a failed mutation pass does, so it can never abort judging.
  private async oraclePass(task: Task, cwd: string, base: string, frozenInvariants?: string[]): Promise<OracleOutcome | null> {
    if (!this.store.config().verification.oracles.enabled) return null;
    try {
      return await this.runOraclePass(task, cwd, base, frozenInvariants);
    } catch (e) {
      this.emit('log', `${task.id} oracles failed, grading with no oracle evidence: ${(e as Error).message.split('\n')[0]}`, undefined, task.id);
      return null;
    }
  }

  private async runOraclePass(task: Task, cwd: string, base: string, frozenInvariants?: string[]): Promise<OracleOutcome | null> {
    const cfg = this.store.config().verification.oracles;
    // With contracts on the invariants come from the verified contract file, not the in-memory plan.
    const invariants = frozenInvariants ?? task.invariants ?? [];
    if (!invariants.length) {
      this.emit('log', `${task.id} oracles skipped: the contract has no invariants for this task`, undefined, task.id);
      return null;
    }
    const models = this.harness.config.models;
    let model = cfg.model ?? models.judge;
    if (model === models.worker && models.judge !== models.worker) model = models.judge;
    const dir = this.store.path('runs', this.run.id, 'oracles', task.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const res = await this.call(
      'judge',
      task,
      task.attempts,
      {
        prompt: oraclePrompt({ task, invariants, target: cwd, dir }),
        cwd: dir,
        tools: ['Read', 'Grep', 'Glob', 'Write'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
        disallowedTools: ['Edit', 'Bash'],
        permissionMode: 'default',
      },
      model,
    );
    // No session or no files means no oracle evidence. Running anyway would report an empty independent
    // result as a failure and sink a healthy task, so degrade to the normal judge instead.
    if (!res.ok) {
      this.emit('log', `${task.id} oracle session failed (${res.error ?? 'error'}); grading with no oracle evidence`, undefined, task.id);
      return null;
    }
    const written = listOracleFiles(dir);
    if (!written.tests.length && !written.probes.length) {
      this.emit('log', `${task.id} oracle session wrote no files; grading with no oracle evidence`, undefined, task.id);
      return null;
    }
    const out = runOracles({
      repoRoot: this.store.root,
      // The commit the task started from, so changes landed by earlier tasks it depends on are not read as drift.
      baseRef: base,
      tree: cwd,
      taskBase: base,
      oracleDir: dir,
      env: { seed: cfg.seed, propertyRuns: cfg.propertyRuns },
      differential: cfg.differential,
      excludeWorkerTests: cfg.excludeWorkerTests,
    });
    this.emit('log', `${task.id} oracles ${out.pass ? 'passed' : 'FAILED'} (${out.files.length} file(s)${out.nonGrading.length ? `, ${out.nonGrading.length} worker test(s) non-grading` : ''})`, undefined, task.id);
    return out;
  }

  // W6.5: worker turns and dollars spent on this task across attempts against the caps.
  private budgetState(task: Task): BudgetState {
    const u = this.workerUse.get(task.id) ?? { turns: 0, usd: 0 };
    return { turnsUsed: u.turns, maxTurns: this.cfg.budgets?.workerPrompt.maxTurns ?? 0, usdSpent: u.usd, usdCap: this.harness.config.budgetUsd.worker };
  }

  // Session caps for the next worker call: what is left of the task budget. Undefined when the feature is off.
  // `shares` splits what is left between workers that run at the same time (best-of-n), so together they stay inside the cap.
  private workerCap(task: Task, shares = 1): { turns: number; usd: number } | undefined {
    if (!this.cfg.budgets?.workerPrompt.enabled) return undefined;
    const b = this.budgetState(task);
    return { turns: Math.max(1, Math.floor((b.maxTurns - b.turnsUsed) / shares)), usd: Math.max(0.01, round((b.usdCap - b.usdSpent) / shares, 4)) };
  }

  private warmed(): void {
    this.cacheWarmed = true;
    this.wakeScheduler();
  }

  // W6.6: n worker samples in separate worktrees, selected by the test command and scenario checks before
  // the judge sees only the winner. A tie keeps the first sample. Sample 1 is the task worktree itself.
  private async sampleBest(task: Task, wt: g.Worktree, base: string, n: number, prompt: string, common: Pick<AgentRequest, 'allowedTools' | 'disallowedTools' | 'permissionMode'>): Promise<AgentResult> {
    const { store } = this;
    const cfg = store.config();
    const trees: g.Worktree[] = [wt];
    try {
      for (let i = 2; i <= n; i++) {
        const id = `${task.id}-s${i}`;
        g.removeWorktree(store.root, join(this.wtRoot, this.run.id, id));
        g.deleteBranch(store.root, `orchestra/${this.run.id}/${id}`);
        trees.push(g.createTaskWorktree(store.root, this.wtRoot, this.run.id, id, this.knownGood));
      }
      this.emit('log', `${task.id} best-of-${n}: running ${n} worker samples in parallel`, undefined, task.id);
      this.save();
      // The samples run together and each spends from the same task budget, so each gets 1/n of what is left.
      // allSettled: one sample that throws must not discard the others or skip the cleanup below.
      const settled = await Promise.allSettled(trees.map((w, i) => this.call('worker', task, task.attempts, { prompt, cwd: w.path, ...common }, undefined, i === 0 ? undefined : (`s${i + 1}` as AgentVariant), trees.length)));
      const works: AgentResult[] = settled.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        const error = `sample ${i + 1} crashed: ${(r.reason as Error)?.message ?? r.reason}`;
        this.emit('log', `${task.id} best-of-${n}: ${error}`, undefined, task.id);
        return { ok: false, text: '', costUsd: 0, turns: 0, durationMs: 0, error };
      });
      const checks = this.scenarios.filter((s) => s.check?.trim()).map((s) => s.check!);
      const cands: (TestCandidate & { index: number })[] = [];
      for (let i = 0; i < trees.length; i++) {
        g.commitAll(trees[i].path, `${task.id}: ${task.title} (orchestra attempt ${task.attempts}, sample ${i + 1})`);
        if (!works[i].ok || !g.hasChangesSince(trees[i].path, base)) continue;
        const tests = cfg.testCommand ? await g.runTestsAsync(trees[i].path, cfg.testCommand, undefined, scrubVerifierEnv(process.env)) : undefined;
        let passed = 0;
        for (const c of checks) if ((await g.runTestsAsync(trees[i].path, c, undefined, scrubVerifierEnv(process.env))).ok) passed++;
        cands.push({ index: i, id: String(i), testsPassed: tests ? (tests.ok ? 1 : 0) : 0, testsTotal: tests ? 1 : 0, distinguishingPasses: passed });
      }
      const winner = (cands.length ? (selectBestByTests(cands) ?? cands[0]) : undefined)?.index ?? 0;
      this.emit('log', `${task.id} best-of-${n}: sample ${winner + 1} selected${cands.length ? ` (${cands.map((c) => `#${c.index + 1} tests ${c.testsPassed}/${c.testsTotal}, checks ${c.distinguishingPasses}`).join('; ')})` : ' (no sample produced a change)'}`, { bestOfN: { n, winner: winner + 1, candidates: cands } }, task.id);
      this.ledgerOutcome(task, 'best_of_n');
      if (winner !== 0) g.resetTo(wt.path, g.head(trees[winner].path));
      return works[winner];
    } finally {
      for (const t of trees.slice(1)) {
        g.removeWorktree(store.root, t.path);
        g.deleteBranch(store.root, t.branch);
      }
    }
  }

  // Judged-pass task: risk-tier gate (W7.1), then the merge queue (per task, or batched W6.2).
  private land(task: Task): Promise<void> {
    const cfg = this.store.config();
    this.mergeReadyAt.set(task.id, Date.now());
    const tiers = cfg.oversight?.riskTiers;
    if (tiers?.enabled && task.worktree) {
      const base = g.mergeBase(task.worktree, 'HEAD', this.integration.branch);
      const diff = g.diffSince(task.worktree, base, Infinity);
      const diffLines = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
      const risk = classifyRisk({ changedFiles: g.changedFiles(task.worktree, base), diffLines, deterministicGreen: task.verdict?.testsPassed === true }, tiers);
      task.risk = risk;
      if (risk.tier === 'high') {
        task.status = 'awaiting_approval';
        task.approval = { requestedAt: Date.now() };
        this.emit('task.approval', `${task.id} is high risk and waits for \`orchestra approve ${this.run.id} ${task.id} --by <name>\`: ${risk.reasons.join('; ')}`, { risk }, task.id);
        this.save();
        return Promise.resolve();
      }
    }
    return cfg.throughput?.batchMerge.enabled ? this.enqueueBatch(task) : this.enqueueMerge(task);
  }

  private enqueueBatch(task: Task): Promise<void> {
    return new Promise<void>((resolve) => {
      this.batchQueue.push({ task, resolve });
      this.pokeBatch();
    });
  }

  // Flush once the queue is full or every in-flight attempt is already waiting in it, so disjoint
  // tasks that finish around the same time share one post-merge test run.
  private pokeBatch(): void {
    const max = this.cfg.throughput?.batchMerge.maxBatch ?? 4;
    const q = this.batchQueue.length;
    if (!q || (q < max && q < this.inflight.size)) return;
    const items = this.batchQueue;
    this.batchQueue = [];
    const job = this.mergeChain.then(() => this.mergeBatches(items));
    this.mergeChain = job.catch(() => undefined);
  }

  private async mergeBatches(items: { task: Task; resolve: () => void }[]): Promise<void> {
    const max = this.cfg.throughput?.batchMerge.maxBatch ?? 4;
    try {
      for (const ids of planBatches(items.map((i) => i.task), max)) {
        const batch = ids.map((id) => items.find((i) => i.task.id === id)!.task);
        try {
          await this.mergeBatch(batch);
        } catch (err) {
          for (const t of batch) if (t.status === 'merging') this.fail(t, `internal error: ${(err as Error).message}`);
          g.resetTo(this.integration.path, this.knownGood);
        }
      }
    } finally {
      for (const i of items) i.resolve();
    }
  }

  // Merge a disjoint batch, run the post-merge tests once, bisect on failure. Bad tasks are reset out
  // and go to repair; good ones stay merged.
  private async mergeBatch(batch: Task[]): Promise<void> {
    const cfg = this.store.config();
    const ip = this.integration.path;
    const before = g.head(ip);
    const footprints = new Map(batch.map((t) => [t.id, this.footprint(t)]));
    const mergeAll = (tasks: Task[]): Task[] => {
      g.resetTo(ip, before);
      const failed: Task[] = [];
      for (const t of tasks) if (!g.merge(ip, t.branch!, `Merge ${t.id}: ${t.title}`).ok) failed.push(t);
      return failed;
    };
    const conflicted = mergeAll(batch);
    for (const t of conflicted) {
      this.ledgerOutcome(t, 'conflict');
      g.resetTo(t.worktree!, before);
      this.repairOrFail(t, ['Your previous change conflicted with work merged by other tasks. Re-implement the task on top of the latest code.']);
    }
    let landing = batch.filter((t) => !conflicted.includes(t));
    if (landing.length && cfg.testCommand) {
      const byId = new Map(landing.map((t) => [t.id, t]));
      // Failing output per task: the last (smallest) failing run that included it, so repair notes never carry
      // the tail of an unrelated passing run.
      const failTails = new Map<string, string>();
      const res = await bisectBatch(landing.map((t) => t.id), async (ids) => {
        if (mergeAll(ids.map((id) => byId.get(id)!)).length) return false;
        const r = await g.runTestsAsync(ip, cfg.testCommand!);
        if (!r.ok) for (const id of ids) failTails.set(id, r.tail);
        return r.ok;
      });
      this.emit('log', `batch of ${landing.length} tested in ${res.testRuns} post-merge run(s); ${res.bad.length} bad`, { batch: landing.map((t) => t.id), bad: res.bad });
      const bad = landing.filter((t) => res.bad.includes(t.id));
      landing = landing.filter((t) => !res.bad.includes(t.id));
      // The good halves were tested apart; test the union once so an interaction between them cannot land untested.
      if (bad.length && landing.length > 1) {
        const settled = await this.settleUnion(landing, mergeAll, ip, cfg.testCommand);
        landing = settled.kept;
        for (const [id, tail] of settled.tails) failTails.set(id, tail);
      } else if (bad.length) mergeAll(landing);
      // With nothing bad the first run tested the whole landing set and nothing has touched the worktree since,
      // so HEAD is the commit that was tested. Re-merging would build a different, untested one.
      const dropped = batch.filter((t) => !conflicted.includes(t) && !landing.includes(t) && !bad.includes(t));
      bad.push(...dropped);
      for (const t of bad) {
        g.resetTo(t.worktree!, before);
        this.repairOrFail(t, [`After merging with other tasks the test suite fails. Re-implement on the latest code. Output tail:\n${(failTails.get(t.id) ?? '').slice(-1200)}`]);
      }
    }
    this.knownGood = g.head(ip);
    for (const t of landing) this.markMerged(t, footprints.get(t.id));
  }

  // Test the landing set as a whole. If it fails, add tasks one at a time and drop any that break the
  // cumulative set (rare path, at most one run per task). Returns the kept tasks and, for each dropped one,
  // the output of the run that rejected it.
  private async settleUnion(landing: Task[], mergeAll: (tasks: Task[]) => Task[], ip: string, cmd: string): Promise<{ kept: Task[]; tails: Map<string, string> }> {
    const tails = new Map<string, string>();
    if (mergeAll(landing).length === 0) {
      const r = await g.runTestsAsync(ip, cmd);
      if (r.ok) return { kept: landing, tails };
      for (const t of landing) tails.set(t.id, r.tail);
    }
    const kept: Task[] = [];
    let inPlace = false; // the worktree holds exactly `kept`, as last tested
    for (const t of landing) {
      const conflicts = mergeAll([...kept, t]).length;
      const r = conflicts === 0 ? await g.runTestsAsync(ip, cmd) : undefined;
      if (r?.ok) {
        kept.push(t);
        inPlace = true;
      } else {
        tails.set(t.id, r ? r.tail : 'It conflicts with the other tasks of the batch.');
        inPlace = false;
      }
    }
    if (!inPlace) mergeAll(kept);
    return { kept, tails };
  }

  private markMerged(task: Task, footprint?: { planned: string[]; changed: string[]; declared?: string[] }): void {
    task.status = 'merged';
    task.endedAt = Date.now();
    task.mergeWaitMs = Date.now() - (this.mergeReadyAt.get(task.id) ?? Date.now());
    this.markCriteriaPassing(task);
    this.ledgerOutcome(task, 'merged', footprint);
    this.emit('task.merged', `${task.id} merged (attempt ${task.attempts})`, { mergeWaitMs: task.mergeWaitMs }, task.id);
    this.save();
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
    this.knownGood = g.head(ip);
    this.markMerged(task, footprint);
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
      allowLocalBinding: this.sandboxOpt?.allowLocalBinding,
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

  private async call(role: Role, task: Task | undefined, attempt: number, req: Omit<AgentRequest, 'role' | 'system' | 'model' | 'budgetUsd'>, modelOverride?: string, variant?: AgentVariant, capShares = 1): Promise<AgentResult> {
    const { run, harness } = this;
    const cap = role === 'worker' && task ? this.workerCap(task, capShares) : undefined;
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
    let res: AgentResult;
    try {
      res = await this.provider.run({
        ...req,
        ...this.isolation(role, req.cwd),
        role,
        model,
        system: harness.prompts[role],
        budgetUsd: cap ? cap.usd : harness.config.budgetUsd[role],
        ...(cap ? { maxTurns: cap.turns } : {}),
        timeoutMs: TIMEOUT_MS[role],
        logFile: this.store.path('runs', run.id, 'logs', `${task?.id ?? 'run'}-${role}-${attempt}${sfx}.jsonl`),
        meta: { task: task?.id, attempt, run: run.id, variant },
        onAction: (action) => {
          agent.lastAction = action;
          if (role === 'worker' && !this.cacheWarmed) this.warmed();
          if (!action.startsWith('says:')) agent.tools += 1;
          this.emit('agent.action', action, undefined, task?.id, role);
          if (Date.now() - lastSave > 200) {
            lastSave = Date.now();
            this.save();
          }
        },
      });
    } catch (e) {
      // A runner that throws must not leave a phantom active agent behind.
      run.active = run.active.filter((a) => a !== agent);
      throw e;
    }
    run.active = run.active.filter((a) => a !== agent);
    if (role === 'worker' && task) {
      const u = this.workerUse.get(task.id) ?? { turns: 0, usd: 0 };
      this.workerUse.set(task.id, { turns: u.turns + res.turns, usd: u.usd + res.costUsd });
    }
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

// Who asked for the run: ORCHESTRA_REQUESTER, else git user.name, else "unknown" (W7.1).
function detectRequester(root: string): string {
  const env = process.env.ORCHESTRA_REQUESTER?.trim();
  if (env) return env;
  const r = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
  return (r.status === 0 && r.stdout.trim()) || UNKNOWN_REQUESTER;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export async function runGoal(opts: ConductorOptions): Promise<Run> {
  return new Conductor(opts).execute();
}

export type ResumeOptions = Omit<ConductorOptions, 'goal' | 'kind' | 'baseRef' | 'harnessVersion'> & { runId: string };

// Throws with the reason a run cannot be resumed (W7.1); returns the stored run otherwise.
export function assertResumable(store: Store, runId: string): Run {
  const run = store.loadRun(runId);
  if (!run) throw new Error(`unknown run "${runId}"`);
  const held = run.tasks.filter((t) => t.status === 'awaiting_approval');
  if (held.length) {
    throw new Error(`run ${runId} still has tasks awaiting approval (${held.map((t) => t.id).join(', ')}). Approve them first: ${held.map((t) => `orchestra approve ${runId} ${t.id} --by <name>`).join('; ')}`);
  }
  if (!run.deferred?.length) throw new Error(`run ${runId} has nothing to resume (status ${run.status}); only a run finalised by \`orchestra approve\` with deferred work can be resumed`);
  if (!run.integrationBranch || !run.baseRef) throw new Error(`run ${runId} has no integration branch or base commit to resume from`);
  return run;
}

// One resume per run at a time: an O_EXCL lock file holding the resumer's pid. A lock whose pid is gone (a crashed
// or killed resume) is stale and is taken over, so a run that died mid-resume stays resumable.
function acquireResumeLock(store: Store, runId: string): () => void {
  const path = store.path('runs', runId, 'resume.lock');
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      try {
        pid = Number(readFileSync(path, 'utf8').trim());
      } catch {
        // removed between our write and read; the next try takes it
      }
      if (pidAlive(pid)) throw new Error(`run ${runId} is already being resumed (pid ${pid}). Wait for it to finish, or delete ${path} if that process is not an orchestra resume`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not take the resume lock ${path}`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Finish a run held for approval once its held tasks are approved: same run id, same integration branch.
export async function resumeRun(opts: ResumeOptions): Promise<Run> {
  if (!opts.store.loadRun(opts.runId)) throw new Error(`unknown run "${opts.runId}"`);
  const release = acquireResumeLock(opts.store, opts.runId);
  try {
    // Checked under the lock, so a resume that just finished (marker cleared) is not run twice.
    const run = assertResumable(opts.store, opts.runId);
    return await new Conductor({ ...opts, goal: run.goal, kind: run.kind, harnessVersion: run.harness, baseRef: run.baseRef }, run).resume();
  } finally {
    release();
  }
}
