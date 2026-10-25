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
  evidence?: string; // what the judge ran or observed to reach this result (W4.2)
}

// Recorded when a judge panel scored the task (W4.1).
export interface PanelRecord {
  votes: { judge: string; model: string; lineage: string; pass: boolean; score: number; criteria?: Record<string, boolean> }[]; // one per judge
  disagreement: number; // mean share of judges in the minority per criterion, 0 = unanimous
  perCriterion: { criterion: string; pass: number; fail: number; disagreement: number }[];
  escalated: boolean; // a split vote went to the escalation model, whose verdict decided
}

export interface Verdict {
  panel?: PanelRecord;
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
  invariants?: string[]; // planner-written invariants for oracles (W4.3/W4.4)
  footprint?: { files: string[]; symbols?: string[] }; // planner-declared files and symbols (sanitised)
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
  check?: string; // optional shell command that checks this scenario (W4.2)
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
  atlasSha?: string; // commit the Repo Atlas was built at, when context.atlas is enabled
  tasks: Task[];
  costUsd: number;
  satisfaction?: number;
  active: ActiveAgent[];
  error?: string;
  mutation?: { total: number; killed: number; score?: number; floor: number; pass?: boolean; invalid?: number; skipped?: string }; // W4.5; skipped (with a reason) means no score was computed, so there is no score or pass
  contract?: { path: string; sha256: string }; // W4.3 the acceptance contract workers cannot edit
  verificationModes?: string[]; // M4 modes enabled when the run started (panel, agentic, contracts, oracles, mutation); absent = none
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
  toolCounts?: Record<string, number>; // tool_use blocks by tool name; absent on legacy rows
  footprint?: { planned: string[]; changed: string[]; declared?: string[] }; // on merged outcome rows: planned (named in the task text) vs changed files; declared = planner footprint files that exist
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

// M4 Verification. Every part is opt-in and off by default.
export interface VerificationConfig {
  contracts: { enabled: boolean }; // W4.3 planner writes a machine-readable acceptance contract workers cannot edit
  panel: {
    enabled: boolean; // W4.1 score with a panel of judges and record disagreement
    judges: { model: string; lineage?: string }[]; // panel members; lineage names the prompt variant
    escalateModel: string | null; // model that breaks split votes; null = the harness judge model
  };
  agenticJudge: {
    enabled: boolean; // W4.2 the judge runs checks per requirement instead of only reading the diff
    checkTimeoutMs: number; // timeout for one check command
  };
  oracles: {
    enabled: boolean; // W4.4 independent oracles for repos without tests
    model: string | null; // model that writes oracle tests; null = the judge model, never the worker's
    propertyRuns: number; // cases per property-based check
    seed: number; // property test seed, fixed for reproducibility
    differential: boolean; // compare unchanged behaviour against the base commit
    excludeWorkerTests: boolean; // a worker's own tests never count towards its grade
  };
  mutation: {
    enabled: boolean; // W4.5 report a mutation score per run
    floor: number; // minimum share of mutants that tests and scenarios must kill, 0..1
    maxMutants: number; // cap on mutants generated per run
    failBelowFloor: boolean; // fail the run when the score is under the floor; false = report only
  };
}

export interface ProjectConfig {
  // Opt-in OS sandbox settings, read from the repo's own .orchestra/config.json only.
  sandbox?: { allowedHosts?: string[] };
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
  context: {
    atlas: {
      enabled: boolean; // Repo Atlas: commit-keyed code graph (W9)
      mapTokens: number; // budget for the L0 ranked map
      packs: boolean; // L1 task packs in worker prompts
      packTokens: number; // budget for one L1 pack
    };
  };
  verification: VerificationConfig;
  learnings?: { expiryDays: number }; // drop lessons with evidence older than this many days; 0 = off
  evolve: {
    every: number; // auto-evolve after every N completed runs, 0 disables
    autoPromote: boolean;
    minGain: number;
    sample: number; // eval cases per evaluation, newest first; bounds cost
    minCases: number; // refuse to promote when fewer eval cases were evaluated
    candidates: number; // variants proposed per cycle; 1 = classic single-variant loop
    promotionRule: 'gain' | 'paired'; // 'gain' = gain above max(minGain, spread); 'paired' = 95% CI lower bound above zero
    niMargin: number; // paired rule: a task type whose mean delta is below -niMargin vetoes promotion
    minJudgeAgreement?: number | null; // refuse to evolve when the incumbent's judge/hidden-check agreement is below this; null = off
    budgetUsd?: number; // hard cap on spend per evolve cycle; 0 or unset = no cap
    sequential?: { enabled: boolean; roundSize: number }; // evaluate in rounds, stop once the CI settles the comparison
    splits?: { enabled: boolean; feedback: number; validation: number; holdout: number; signoffBelow: number }; // time-split eval sets
    cascade?: { enabled: boolean; minibatch: number; finalists: number }; // smoke test, minibatch vs parent, full validation for the top finalists only
    regression?: { enabled: boolean }; // always replay the regression-tagged cases of the validation pool (W3.2)
    pareto?: { enabled: boolean }; // choose parents from the Pareto archive, show scored history, record per-case wins
    cost?: { enabled: boolean; maxCostRisePct: number; minGainForCost: number; costWeight: number; timeWeight: number }; // cost-aware objective
  };
}
