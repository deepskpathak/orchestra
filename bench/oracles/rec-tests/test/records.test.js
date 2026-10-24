import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunk, groupBy, sortBy } from '../src/records.js';

test('groupBy groups by key', () => assert.deepEqual(groupBy([1, 2, 3, 4], (n) => n % 2), { 1: [1, 3], 0: [2, 4] }));
test('groupBy keeps input order', () => assert.deepEqual(groupBy(['b', 'a', 'c'], () => 'k'), { k: ['b', 'a', 'c'] }));
test('sortBy sorts ascending', () => assert.deepEqual(sortBy([{ n: 2 }, { n: 1 }, { n: 3 }], 'n').map((x) => x.n), [1, 2, 3]));
test('sortBy sorts strings', () => assert.deepEqual(sortBy([{ s: 'b' }, { s: 'a' }], 's').map((x) => x.s), ['a', 'b']));
test('chunk splits with a remainder', () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
test('chunk with a large size', () => assert.deepEqual(chunk([1, 2], 5), [[1, 2]]));
