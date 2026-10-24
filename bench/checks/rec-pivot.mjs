import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(`${process.cwd()}/src/records.js`).href);
const rows = [{ r: 'x', c: 'a', v: 1 }, { r: 'x', c: 'b', v: 2 }, { r: 'y', c: 'a', v: 3 }, { r: 'x', c: 'a', v: 9 }];
assert.deepEqual(m.pivot(rows, 'r', 'c', 'v'), { x: { a: 9, b: 2 }, y: { a: 3 } });
assert.deepEqual(m.pivot([], 'r', 'c', 'v'), {});
