import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, intGen, stringGen, arrayGen, oneOfGen, checkProperty, differential,
  workerOwnedTests, gradingTestFiles, oracleVerdict,
} from '../src/oracles.ts';
import { runOracleTests, runProbe } from '../src/oracle-run.ts';

test('same seed gives same sequence, different seed differs', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const sa = [a(), a(), a(), a()], sb = [b(), b(), b(), b()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, [c(), c(), c(), c()]);
  assert.ok(sa.every((x) => x >= 0 && x < 1));
});

test('generators are deterministic and respect bounds', () => {
  const gen = arrayGen(intGen(0, 5), 4);
  const x = gen.generate(mulberry32(7)), y = gen.generate(mulberry32(7));
  assert.deepEqual(x, y);
  assert.ok(x.length <= 4 && x.every((n) => n >= 0 && n <= 5));
  assert.ok(stringGen(5).generate(mulberry32(1)).length <= 5);
  assert.ok(['a', 'b'].includes(oneOfGen(['a', 'b']).generate(mulberry32(3))));
});

test('true property passes', () => {
  const r = checkProperty((n: number) => n + 0 === n, intGen(), 50, 9);
  assert.equal(r.passed, true);
  assert.equal(r.runs, 50);
});

test('false property returns counterexample and seed; shrinking reduces ints', () => {
  const r = checkProperty((n: number) => n < 10, intGen(-1000, 1000), 200, 5);
  assert.equal(r.passed, false);
  assert.equal(r.seed, 5);
  assert.equal(r.counterexample, 10);
  assert.ok((r.original as number) >= 10);
  assert.ok(r.shrinkSteps! >= 0);
  // reproducible
  assert.deepEqual(checkProperty((n: number) => n < 10, intGen(-1000, 1000), 200, 5), r);
});

test('shrinking reduces arrays and throwing counts as failure', () => {
  const r = checkProperty((a: number[]) => !a.includes(3), arrayGen(intGen(0, 5), 10), 300, 2);
  assert.equal(r.passed, false);
  assert.deepEqual(r.counterexample, [3]);
  const t = checkProperty((n: number) => { if (n > 0) throw new Error('boom'); return true; }, intGen(0, 50), 50, 1);
  assert.equal(t.passed, false);
  assert.equal(t.error, 'boom');
  assert.equal(t.counterexample, 1);
});

test('differential passes on identical output and reports mismatches', () => {
  const f = (i: string) => ({ stdout: i.toUpperCase(), exit: 0 });
  assert.equal(differential(f, f, ['a', 'b']).passed, true);
  const g = (i: string) => (i === 'b' ? { stdout: 'x', exit: 1 } : f(i));
  const d = differential(f, g, ['a', 'b']);
  assert.equal(d.passed, false);
  assert.equal(d.total, 2);
  assert.deepEqual(d.mismatches.map((m) => m.input), ['b']);
  assert.equal(differential(f, (i) => ({ stdout: i.toUpperCase(), exit: 2 }), ['a']).passed, false);
});

test('worker-owned test files are excluded from grading files', () => {
  const globs = ['test/**/*.test.ts', '**/*_test.py'];
  const changed = ['src/a.ts', 'test/a.test.ts', 'test/sub/b.test.ts', 'pkg/x_test.py'];
  const owned = workerOwnedTests(changed, globs);
  assert.deepEqual(owned, ['test/a.test.ts', 'test/sub/b.test.ts', 'pkg/x_test.py']);
  const all = ['test/a.test.ts', 'test/c.test.ts', 'test/sub/b.test.ts', 'pkg/x_test.py'];
  assert.deepEqual(gradingTestFiles(all, owned), ['test/c.test.ts']);
});

test('oracleVerdict combines results into pass plus issues', () => {
  const ok = checkProperty(() => true, intGen(), 5, 1);
  const bad = checkProperty((n: number) => n < 1, intGen(0, 9), 50, 1);
  const dOk = differential((i) => ({ stdout: i, exit: 0 }), (i) => ({ stdout: i, exit: 0 }), ['a']);
  const dBad = differential((i) => ({ stdout: i, exit: 0 }), () => ({ stdout: 'z', exit: 0 }), ['a']);
  const pass = oracleVerdict({ property: [ok], differential: dOk, independent: { passed: true, files: ['test/c.test.ts'] } });
  assert.deepEqual(pass, { pass: true, issues: [], checked: 3 });
  const fail = oracleVerdict({ property: [bad], differential: dBad, independent: { passed: false, files: ['t'], detail: '2 failed' } });
  assert.equal(fail.pass, false);
  assert.equal(fail.issues.length, 3);
  assert.equal(oracleVerdict({}).pass, false);
  assert.equal(oracleVerdict({ independent: { passed: true, files: [] } }).pass, false);
});

// Oracle tests and probes execute worker-written code: no credentials from the orchestrator env may reach them.
test('oracle probes and tests run with a scrubbed env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-oracle-env-'));
  const saved = { GH_TOKEN: process.env.GH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.GH_TOKEN = 'secret-gh';
  process.env.ANTHROPIC_API_KEY = 'secret-model';
  try {
    const env = { seed: 7, propertyRuns: 3 };
    writeFileSync(join(dir, 'probe-env.mjs'), 'console.log(JSON.stringify([process.env.GH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.ORACLE_SEED, typeof process.env.PATH]));\n');
    const out = runProbe(dir, join(dir, 'probe-env.mjs'), env);
    assert.equal(out.exit, 0);
    assert.deepEqual(JSON.parse(out.stdout), [null, null, '7', 'string']);
    writeFileSync(join(dir, 'leak.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('no secrets', () => { assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.ANTHROPIC_API_KEY, undefined); });\n");
    assert.equal(runOracleTests(dir, [join(dir, 'leak.test.mjs')], env).ok, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
