// Agentic judge (W4.2): run the scenario checks and the test command before judging, and tell the judge
// to verify each acceptance criterion by execution. Pure helpers with an injectable exec.
import type { Scenario } from './types.ts';

export interface CheckResult {
  id: string; // scenario id, or 'tests' for the configured test command
  command: string;
  ok: boolean;
  exit: number | null; // null when the command timed out or could not start
  tail: string;
}

// Same shape as git.runTests plus an optional exit code, so tests can inject a fake.
export type CheckExec = (cwd: string, command: string, timeoutMs: number) => { ok: boolean; exit?: number | null; tail: string };

const TAIL_CHARS = 1200;

// Runs every scenario that has a check command, then the test command (when given). Scenarios without a check are skipped.
export function runScenarioChecks(i: { cwd: string; scenarios: Scenario[]; testCommand?: string; testsResult?: { ok: boolean; exit?: number | null; tail: string } | null; timeoutMs: number; exec: CheckExec }): CheckResult[] {
  const jobs: { id: string; command: string }[] = [];
  for (const s of i.scenarios) if (s.check && s.check.trim()) jobs.push({ id: s.id, command: s.check });
  const run = (j: { id: string; command: string }): CheckResult => {
    try {
      const r = i.exec(i.cwd, j.command, i.timeoutMs);
      return { id: j.id, command: j.command, ok: r.ok, exit: r.exit ?? (r.ok ? 0 : null), tail: r.tail.slice(-TAIL_CHARS) };
    } catch (err) {
      return { id: j.id, command: j.command, ok: false, exit: null, tail: `check could not run: ${(err as Error).message}` };
    }
  };
  const results = jobs.map(run);
  // The conductor already ran the test command for the TEST RESULT section, so reuse it instead of running it twice.
  if (i.testCommand) {
    const r = i.testsResult;
    results.push(r ? { id: 'tests', command: i.testCommand, ok: r.ok, exit: r.exit ?? (r.ok ? 0 : null), tail: r.tail.slice(-TAIL_CHARS) } : run({ id: 'tests', command: i.testCommand }));
  }
  return results;
}

export function executedChecksSection(results: CheckResult[]): string {
  if (!results.length) return 'EXECUTED CHECKS: none configured (run your own builds, tests and scenario scripts).';
  const lines = results.map((r) => `- ${r.id}: \`${r.command}\` ${r.ok ? 'PASSED' : 'FAILED'} (exit ${r.exit ?? 'n/a'})${r.tail.trim() ? `\n${r.tail.trim()}` : ''}`);
  return `EXECUTED CHECKS (run by the conductor in the task worktree before judging):\n${lines.join('\n')}`;
}

export const AGENTIC_INSTRUCTION =
  'AGENTIC JUDGING: do not rely on reading the diff alone. For each acceptance criterion, use Bash to run the relevant build, tests and scenario scripts, and judge from what you observe. ' +
  'Return `evidence` on every criterion: the command you ran and the observed result. A criterion you could not verify by execution should not pass.';

export const NO_EVIDENCE_NOTE = 'Criterion passed without executed evidence';
