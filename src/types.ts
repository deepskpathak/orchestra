// Shared domain types. Everything Orchestra persists is one of these shapes, as JSON.

import type { IntegrityFlag } from './integrity.ts';

export type Role = 'planner' | 'worker' | 'judge' | 'librarian' | 'evolver';

export type TaskStatus =
  | 'pending' // waiting on deps or a free slot
  | 'running' // worker session active
  | 'judging' // tests + judge session active
  | 'repair' // judge rejected, queued for another worker attempt
  | 'merging' // waiting in the merge queue
  | 'merged' // landed on the integration branch
  | 'failed' // out of attempts
  | 'needs_human' // worker flagged a spec/test contradiction; stops repair, not a failure
  | 'blocked'; // a dependency failed

// What a worker session can end with besides plain completion.
export type WorkerOutcome = { outcome: 'done' } | { outcome: 'flag_for_human'; reason: string };

export interface CriterionResult {
  criterion: string;
  pass: boolean;
  score: number; // 0..1
  note?: string;
}

export interface Verdict {
  pass: boolean;
  score: number; // 0..1 satisfaction estimate from the judge
  summary: string;
  issues: string[];
  testsPassed: boolean | null; // null when no test command is configured
  criteria?: CriterionResult[]; // per-acceptance-criterion results, when the judge supplied them
  judgeError?: string; // set when the judge itself failed; score is meaningless then
}

export interface ContrastRecord {
  attempt: number; // the repair attempt number the pair ran on
  a: { branch: string; verdict?: Verdict };
  b: { branch: string; verdict?: Verdict };
  picked: 'A' | 'B' | null;
  reasons: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  deps: string[];
  status: TaskStatus;
  attempts: number;
  branch?: string;
  worktree?: string;
  verdict?: Verdict;
  notes: string[]; // repair notes fed to the next attempt
  integrityFlags?: IntegrityFlag[]; // grading-surface / reward-hack flags raised on this task's diffs (all attempts)
  humanReason?: string; // why the worker flagged the task for a human (status needs_human)
  contrast?: ContrastRecord; // set when a contrastive repair pair ran
  costUsd: number;
  startedAt?: number;
  endedAt?: number;
}

export interface Scenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

export type RunStatus = 'planning' | 'running' | 'compounding' | 'done' | 'failed';

export interface Run {
  id: string;
  goal: string;
  domain?: string; // learnings domain slug chosen by the planner
  harness: string; // harness version id, e.g. "v1"
  kind: 'goal' | 'eval';
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  integrationBranch?: string;
  baseRef?: string;
  tasks: Task[];
  costUsd: number;
  satisfaction?: number;
  active: ActiveAgent[];
  error?: string;
}

// One live agent session, shown as a lane in the dashboard.
export interface ActiveAgent {
  key: string;
  role: Role;
  task?: string;
  model: string;
  startedAt: number;
  lastAction: string;
  tools: number;
  costUsd: number;
}

export type EventKind =
  | 'run.start'
  | 'run.end'
  | 'plan'
  | 'task.start'
  | 'task.verdict'
  | 'task.repair'
  | 'task.merged'
  | 'task.contrast'
  | 'task.failed'
  | 'task.needs_human'
  | 'agent.start'
  | 'agent.action'
  | 'agent.end'
  | 'learn'
  | 'evolve'
  | 'log';

export interface OrchestraEvent {
  t: number;
  run: string;
  kind: EventKind;
  msg: string;
  role?: Role;
  task?: string;
  data?: Record<string, unknown>;
}

// One row per agent session. The raw material for self-evaluation.
export interface LedgerRow {
  t: number;
  run: string;
  kind: 'goal' | 'eval';
  harness: string;
  role: Role;
  task?: string;
  attempt?: number;
  model: string;
  ok: boolean;
  costUsd: number;
  durationMs: number;
  turns: number;
  inputTokens?: number; // token usage; absent on legacy rows
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outcome?: string; // e.g. "pass", "fail", "merged", "conflict"
  score?: number;
}

export interface HarnessConfig {
  // Role to literal model name or tier (strong, balanced, fast). loadHarness resolves tiers.
  models: Record<Role, string>;
  provider?: string;
  maxAttempts: number;
  passThreshold: number;
  budgetUsd: Record<Role, number>;
}

export interface ProjectConfig {
  concurrency: number;
  testCommand: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  runBudgetUsd: number;
  judgeTiers: {
    enabled: boolean; // cheap judge first, escalate to the harness judge model when not decisive
    cheapModel: string;
    margin: number; // escalate when |score - passThreshold| <= margin
  };
  preJudge: {
    enabled: boolean; // cheap deterministic checks before any judge call; failures go straight to repair
    lintCommand: string | null;
    requireTests: boolean; // new exports under src/ need a changed test file
  };
  contrastive: {
    enabled: boolean; // repair attempts run two workers and a comparing judge
    onlyWithoutTests: boolean; // apply only when testCommand is null
    maxPairs: number; // contrastive pairs allowed per task
  };
  fastPath: {
    enabled: boolean; // small single-concern goals get one task and no hidden-scenario requirement
    maxGoalChars: number;
  };
  evolve: {
    every: number; // auto-evolve after every N completed runs, 0 disables
    autoPromote: boolean;
    minGain: number;
    sample: number; // eval cases per evaluation, newest first; bounds cost
    minCases: number; // refuse to promote when fewer eval cases were evaluated
    candidates: number; // variants proposed per cycle; 1 = classic single-variant loop
    promotionRule: 'gain' | 'paired'; // 'gain' = gain above max(minGain, spread); 'paired' = 95% CI lower bound above zero
    niMargin: number; // paired rule: a task type whose mean delta is below -niMargin vetoes promotion
  };
}
