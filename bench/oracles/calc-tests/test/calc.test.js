import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, divide } from '../src/calc.js';

test('add sums', () => assert.equal(add(2, 3), 5));
test('add handles negatives', () => assert.equal(add(-2, -3), -5));
test('divide divides', () => assert.equal(divide(6, 3), 2));
test('divide keeps fractions', () => assert.equal(divide(1, 4), 0.25));
