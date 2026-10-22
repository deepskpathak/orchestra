// Contrastive repair helpers: pure functions, no IO. The conductor owns worktrees and agent calls.

import { buildVerdict, type BuiltPrompt } from './conductor.ts';
import type { ProjectConfig, Scenario, Task, Verdict } from './types.ts';

// Repair attempts only (attempt 2+), and never more than maxPairs pairs per task.
export function contrastApplies(cfg: Pick<ProjectConfig, 'contrastive' | 'testCommand'>, task: Pick<Task, 'attempts' | 'contrast'>): boolean {
  const c = cfg.contrastive;
  if (!c?.enabled || task.attempts < 2) return false;
  const used = task.contrast ? 1 : 0;
  if (used >= c.maxPairs) return false;
  return cfg.testCommand == null || !c.onlyWithoutTests;
}

export function alternateWorkerSection(notes: string[]): string {
  return [
    'ALTERNATE APPROACH: another worker is fixing the same failures by following the repair notes directly.',
    'Take a deliberately different approach to the same failing criteria: a different design, algorithm or structure, not a rewording of the obvious fix. The acceptance criteria still apply in full.',
    notes.length ? `Failing points to address:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export function comparePrompt(i: {
  task: Task;
  scenarios: Scenario[];
  workerTextA: string;
  workerTextB: string;
  diffA: string;
  diffB: string;
}): BuiltPrompt {
  const { task } = i;
  return {
    prefix: `HIDDEN SCENARIOS for the whole goal (judge only the parts this task is responsible for):\n${i.scenarios
      .map((s) => `- ${s.id}: GIVEN ${s.given} WHEN ${s.when} THEN ${s.then}`)
      .join('\n') || '(none)'}\n\nYou are comparing two independent attempts, A and B, at the same task. Score each attempt on its own merits: for each, return pass, score, summary, issues and criteria (one entry per acceptance criterion, in order, each with pass, score and a short note). Then return preferred ("A" or "B") and reasons explaining why it beat the other. Your preference never lowers the bar: an attempt that fails its criteria must be marked failing even if it is the better of the two.`,
    body: [
      `TASK ${task.id}: ${task.title}\n${task.description}`,
      `ACCEPTANCE CRITERIA:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}`,
      `ATTEMPT A WORKER SUMMARY (unverified):\n${i.workerTextA.slice(0, 3000)}`,
      `ATTEMPT A DIFF vs base:\n${i.diffA}`,
      `ATTEMPT B WORKER SUMMARY (unverified):\n${i.workerTextB.slice(0, 3000)}`,
      `ATTEMPT B DIFF vs base:\n${i.diffB}`,
    ].join('\n\n'),
  };
}

const ATTEMPT_SCHEMA = {
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

export const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    a: ATTEMPT_SCHEMA,
    b: ATTEMPT_SCHEMA,
    preferred: { type: 'string', enum: ['A', 'B'] },
    reasons: { type: 'string' },
  },
  required: ['a', 'b', 'preferred', 'reasons'],
};

export interface ContrastResolution {
  a?: Verdict;
  b?: Verdict;
  picked: 'A' | 'B' | null;
  reasons: string;
}

function safeVerdict(raw: unknown, testsOk: boolean | null, passThreshold: number): Verdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as { score?: unknown; criteria?: unknown };
  if (typeof v.score !== 'number' && !Array.isArray(v.criteria)) return undefined;
  try {
    return buildVerdict(raw, testsOk, passThreshold);
  } catch {
    return undefined;
  }
}

// The preferred attempt wins only if it passes on its own; otherwise a passing rival wins;
// otherwise nothing is picked. Malformed judge output yields picked null, never a throw.
export function resolveContrast(raw: unknown, testsOkA: boolean | null, testsOkB: boolean | null, passThreshold: number): ContrastResolution {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const a = safeVerdict(r.a, testsOkA, passThreshold);
  const b = safeVerdict(r.b, testsOkB, passThreshold);
  const reasons = typeof r.reasons === 'string' ? r.reasons : '';
  const preferred = r.preferred === 'A' || r.preferred === 'B' ? r.preferred : null;
  const passes = { A: Boolean(a?.pass), B: Boolean(b?.pass) };
  if (!a && !b) return { picked: null, reasons: reasons || 'Judge output was malformed; no attempt picked.' };
  if (preferred && passes[preferred]) return { a, b, picked: preferred, reasons };
  const other = preferred === 'A' ? 'B' : preferred === 'B' ? 'A' : null;
  if (other && passes[other]) {
    return { a, b, picked: other, reasons: `Preferred attempt ${preferred} did not pass on its own scores, so ${other} was picked because it passes. ${reasons}`.trim() };
  }
  if (!preferred && (passes.A !== passes.B)) {
    const only = passes.A ? 'A' : 'B';
    return { a, b, picked: only, reasons: `No preference given; only ${only} passes. ${reasons}`.trim() };
  }
  return { a, b, picked: null, reasons: `Neither attempt passed. ${reasons}`.trim() };
}
