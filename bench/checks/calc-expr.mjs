import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/calc.js`).href);
const e = m.evaluate;
assert.equal(e('1 + 2 * 3'), 7);
assert.equal(e('(1 + 2) * 3'), 9);
assert.equal(e('10 - 4 - 3'), 3);
assert.equal(e('8 / 4 / 2'), 1);
assert.equal(e('2^3^2'), 512);
assert.equal(e('-2^2'), -4);
assert.equal(e('(-2)^2'), 4);
assert.equal(e('2^-1'), 0.5);
assert.equal(e('1 - -1'), 2);
assert.equal(e('--3'), 3);
assert.equal(e('-(1 + 2) * 2'), -6);
assert.equal(e(' .5 + 2.5 '), 3);
assert.equal(e('2 * -3 ^ 2'), -18);
assert.equal(e('((4))'), 4);
for (const bad of ['', '   ', '1 +', '* 2', '(1 + 2', '1 + 2)', '2(3)', '1 2', '2 ** 3', '1 + a', '()', '1..2', '3 / 0', '1 / (2 - 2)']) {
  assert.throws(() => e(bad), Error, `evaluate(${JSON.stringify(bad)}) must throw`);
}
const src = readFileSync(`${process.cwd()}/src/calc.js`, 'utf8');
assert.ok(!/\beval\s*\(|new\s+Function|\bFunction\s*\(/.test(src), 'no eval or Function');
assert.equal(m.add(2, 3), 5);
