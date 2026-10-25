// W4.4 oracle execution helpers: run-owned oracle files are executed against a worker tree and,
// for probes, against a throwaway worktree at the run base commit. The agent session itself lives in
// the conductor; this module only lists, runs and compares (node:test files and probe scripts).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as g from './git.ts';
import { scrubVerifierEnv } from './sandbox.ts';
import { differential, gradingTestFiles, oracleVerdict, workerOwnedTests, type DifferentialResult, type RunOutput } from './oracles.ts';

export const DEFAULT_TEST_GLOBS = ['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'];

export interface OracleFiles {
  tests: string[]; // *.test.{js,mjs,cjs}, run with node --test against the worker tree
  probes: string[]; // probe*.{js,mjs,cjs}, run on base and head; stdout and exit code must match
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out.sort();
}

export function listOracleFiles(dir: string): OracleFiles {
  const files = walk(dir);
  const name = (f: string) => f.split('/').pop()!;
  return {
    tests: files.filter((f) => /\.test\.(js|mjs|cjs)$/.test(name(f))),
    probes: files.filter((f) => /^probe.*\.(js|mjs|cjs)$/.test(name(f))),
  };
}

export interface OracleEnv {
  seed: number;
  propertyRuns: number;
}

// NODE_TEST_CONTEXT makes a nested `node --test` report to the parent runner and exit 0, so drop it.
// Oracle files and the worker code they import run as plain child processes, outside any agent sandbox,
// so they get the scrubbed env: no push, publish or model credentials. Limitation: the filesystem and
// network are not confined here even when the worker sandbox is on (see docs/isolation.md).
const envFor = (target: string, o: OracleEnv) => ({ ...scrubVerifierEnv(process.env), NODE_TEST_CONTEXT: undefined, CI: '1', ORACLE_TARGET: target, ORACLE_SEED: String(o.seed), ORACLE_RUNS: String(o.propertyRuns) });

export function runOracleTests(tree: string, files: string[], o: OracleEnv, timeoutMs = 120_000): { ok: boolean; tail: string } {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: tree, encoding: 'utf8', timeout: timeoutMs, env: envFor(tree, o) });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.length > 2000 ? '...' + out.slice(-2000) : out;
  if (r.error) return { ok: false, tail: `${r.error.message}\n${tail}` };
  return { ok: r.status === 0, tail };
}

export function runProbe(tree: string, file: string, o: OracleEnv, timeoutMs = 60_000): RunOutput {
  const r = spawnSync(process.execPath, [file], { cwd: tree, encoding: 'utf8', timeout: timeoutMs, env: envFor(tree, o) });
  return { stdout: r.stdout ?? '', exit: r.status ?? -1 };
}

export interface OracleOutcome {
  pass: boolean;
  issues: string[]; // failures, prefixed "oracle:"
  nonGrading: string[]; // worker test files excluded from grading evidence
  files: string[];
}

export function runOracles(i: {
  repoRoot: string; // for creating the base worktree
  baseRef: string; // run base commit
  tree: string; // worker tree
  taskBase: string; // commit the task started from, to find worker-touched files
  oracleDir: string;
  env: OracleEnv;
  differential: boolean;
  excludeWorkerTests: boolean;
  testGlobs?: string[];
}): OracleOutcome {
  const { tests, probes } = listOracleFiles(i.oracleDir);
  const issues: string[] = [];
  const nonGrading = i.excludeWorkerTests ? workerOwnedTests(g.changedFiles(i.tree, i.taskBase), i.testGlobs ?? DEFAULT_TEST_GLOBS) : [];
  // Oracle files live outside the worker tree, so none can be worker-owned; the filter guards a stray overlap.
  const rel = (f: string) => relative(i.oracleDir, f);
  const grading = gradingTestFiles(tests.map(rel), nonGrading).map((f) => join(i.oracleDir, f));
  let independent: { passed: boolean; files: string[]; detail?: string } | undefined;
  if (grading.length || !probes.length) {
    const r = grading.length ? runOracleTests(i.tree, grading, i.env) : { ok: false, tail: '' };
    independent = { passed: r.ok, files: grading, ...(r.ok ? {} : { detail: r.tail.slice(-600) }) };
  }
  let diff: DifferentialResult | undefined;
  if (i.differential && probes.length) {
    const base = join(tmpdir(), `orchestra-oracle-base-${process.pid}-${Date.now()}`);
    try {
      g.git(i.repoRoot, 'worktree', 'add', '-q', '--detach', base, i.baseRef);
      const byName = new Map(probes.map((p) => [rel(p), p]));
      diff = differential((n) => runProbe(base, byName.get(n)!, i.env), (n) => runProbe(i.tree, byName.get(n)!, i.env), [...byName.keys()]);
    } finally {
      g.removeWorktree(i.repoRoot, base);
    }
  }
  const v = oracleVerdict({ ...(independent ? { independent } : {}), ...(diff ? { differential: diff } : {}) });
  for (const s of v.issues) issues.push(`oracle: ${s}`);
  for (const f of nonGrading) issues.push(`non-grading: worker test file ${f} was not used as grading evidence`);
  return { pass: v.pass, issues, nonGrading, files: [...grading, ...probes] };
}
