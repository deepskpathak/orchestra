// Shared helpers for hidden checks. Not a check itself: goals only reference checks/<id>.mjs.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function runTests(cwd, testFile) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', testFile], { cwd, env, encoding: 'utf8', timeout: 60_000 });
}

// The worker's tests must pass on the real source and fail on every mutant of it (so they actually assert something).
export function checkTests({ testFile, srcFile, mutants, minTests }) {
  const cwd = process.cwd();
  assert.ok(existsSync(join(cwd, testFile)), `missing ${testFile}`);
  const text = readFileSync(join(cwd, testFile), 'utf8');
  const count = (text.match(/\b(?:test|it)\(/g) ?? []).length;
  assert.ok(count >= minTests, `need at least ${minTests} tests, found ${count}`);
  const base = runTests(cwd, testFile);
  assert.equal(base.status, 0, `tests fail on the real source\n${base.stdout}${base.stderr}`);
  for (const [from, to] of mutants) {
    const dir = mkdtempSync(join(tmpdir(), 'bench-mutant-'));
    try {
      cpSync(cwd, dir, { recursive: true });
      const src = readFileSync(join(dir, srcFile), 'utf8');
      assert.ok(src.includes(from), `mutation anchor not found: ${from}`);
      writeFileSync(join(dir, srcFile), src.replace(from, to));
      const r = runTests(dir, testFile);
      assert.notEqual(r.status, 0, `tests did not catch mutant: ${from} -> ${to}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// README.md must have an "## API" section and describe each name in backticks followed by a description on the same line.
export function checkReadme(names) {
  const file = join(process.cwd(), 'README.md');
  assert.ok(existsSync(file), 'README.md missing');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^## API\s*$/m, 'README needs an "## API" heading');
  for (const n of names) assert.match(text, new RegExp('`' + n + '`[^\\n]{10,}'), `README must describe ${n}`);
}
