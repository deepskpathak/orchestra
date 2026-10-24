import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capitalize } from '../src/text.js';

test('capitalizes a word', () => assert.equal(capitalize('abc'), 'Abc'));
test('keeps the rest of the word', () => assert.equal(capitalize('aBC'), 'ABC'));
test('handles the empty string', () => assert.equal(capitalize(''), ''));
test('single character', () => assert.equal(capitalize('x'), 'X'));
