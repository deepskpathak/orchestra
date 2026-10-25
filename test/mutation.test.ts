import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateMutants, mutationScore, runMutation } from '../src/mutation.ts';

const SRC = `// a === b && c
const a = x === y && z < 3;
const s = "a === b && true";
/* x > 1 */
const t = \`p + q\`;
if (a >= 2 || ok) return true;
`;

test('mutants are deterministic and differ from the source by one operator', () => {
  const a = generateMutants(SRC, 'f.ts', 100);
  const b = generateMutants(SRC, 'f.ts', 100);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((m) => m.op), ['=== -> !==', '&& -> ||', '< -> <=', '>= -> >', '|| -> &&', 'true -> false']);
  for (const m of a) {
    const [from, to] = m.op.split(' -> ');
    assert.equal(m.source.length - SRC.length, to.length - from.length);
    let diff = 0;
    for (let i = 0; i < SRC.length; i++) if (SRC[i] !== m.source[i]) { diff++; break; }
    assert.equal(diff, 1);
  }
  assert.equal(a[0].line, 2);
});

test('strings and comments are untouched; arrows and increments are not mutated', () => {
  for (const m of generateMutants(SRC, 'f.ts', 100)) {
    assert.ok(m.source.includes('// a === b && c'));
    assert.ok(m.source.includes('"a === b && true"'));
    assert.ok(m.source.includes('/* x > 1 */'));
    assert.ok(m.source.includes('`p + q`'));
  }
  assert.deepEqual(generateMutants('const f = (a) => a++; x--; y += 1; z -> w', 'f.ts', 10), []);
});

test('max is respected and thinning stays in source order', () => {
  const src = Array.from({ length: 10 }, (_, i) => `a${i} === b;`).join('\n');
  assert.equal(generateMutants(src, 'f.ts', 3).length, 3);
  assert.deepEqual(generateMutants(src, 'f.ts', 3).map((m) => m.line), [1, 4, 7]);
  assert.equal(generateMutants(src, 'f.ts', 0).length, 0);
});

test('score math and floor', () => {
  const r = [{ killed: true }, { killed: true }, { killed: false }, { killed: true }];
  assert.deepEqual(mutationScore(r, 0.75), { total: 4, killed: 3, survived: 1, score: 0.75, floor: 0.75, pass: true });
  assert.equal(mutationScore(r, 0.8).pass, false);
});

test('zero mutants is a safe passing result', () => {
  const s = mutationScore([], 0.9);
  assert.deepEqual(s, { total: 0, killed: 0, survived: 0, score: 1, floor: 0.9, pass: true });
});

const fs = (init: Record<string, string>) => {
  const files = { ...init };
  return { files, read: (f: string) => files[f], write: (f: string, c: string) => { files[f] = c; } };
};

test('runner counts killed and survived and restores the source', () => {
  const io = fs({ 'a.ts': 'x === y; p < q;' });
  const orig = io.files['a.ts'];
  const run = runMutation({
    files: ['a.ts'], max: 10, commands: ['t'], read: io.read, write: io.write,
    exec: () => ({ ok: !io.files['a.ts'].includes('!==') }), // only the === mutant is caught
  });
  assert.deepEqual(run.results.map((r) => r.killed), [true, false]);
  assert.equal(io.files['a.ts'], orig);
});

test('runner restores the source when exec throws, and a throw counts as killed', () => {
  const io = fs({ 'a.ts': 'x === y;' });
  let calls = 0;
  const run = runMutation({
    files: ['a.ts'], max: 10, commands: ['t'], read: io.read, write: io.write,
    exec: () => { if (++calls > 1) throw new Error('boom'); return { ok: true }; },
  });
  assert.equal(run.results[0].killed, true);
  assert.equal(io.files['a.ts'], 'x === y;');
});

test('runner skips with no commands or a failing baseline, and honours max across files', () => {
  const io = fs({ 'a.ts': 'a === b; c === d;', 'b.ts': 'e === f;' });
  const base = { files: ['a.ts', 'b.ts'], max: 2, read: io.read, write: io.write };
  assert.match(runMutation({ ...base, commands: [], exec: () => ({ ok: true }) }).skipped!, /no test command/);
  assert.match(runMutation({ ...base, commands: ['t'], exec: () => ({ ok: false }) }).skipped!, /already fail/);
  const r = runMutation({ ...base, commands: ['t'], exec: () => ({ ok: true }) });
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x) => x.file === 'a.ts'));
});

test('a file that cannot be read is left out and the rest are still mutated', () => {
  const io = fs({ 'a.ts': 'x === y;' });
  const run = runMutation({
    files: ['gone.ts', 'a.ts'], max: 10, commands: ['t'], write: io.write,
    read: (f) => { if (f === 'gone.ts') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return io.read(f); },
    exec: () => ({ ok: true }),
  });
  assert.deepEqual(run.unreadable, ['gone.ts']);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].file, 'a.ts');
});
