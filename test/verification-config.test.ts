import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.ts';
import { tempRepo } from './helpers.ts';

function storeWith(config: unknown): Store {
  const store = tempRepo();
  store.writeJson('config.json', config); // replaces the full defaults tempRepo wrote
  return store;
}

test('verification defaults apply when the block is omitted, all disabled', () => {
  const v = storeWith({ concurrency: 2 }).config().verification;
  assert.equal(v.contracts.enabled, false);
  assert.equal(v.panel.enabled, false);
  assert.deepEqual(v.panel.judges, []);
  assert.equal(v.panel.escalateModel, null);
  assert.equal(v.agenticJudge.enabled, false);
  assert.equal(v.oracles.enabled, false);
  assert.equal(v.oracles.propertyRuns, 50);
  assert.equal(v.oracles.excludeWorkerTests, true);
  assert.equal(v.mutation.enabled, false);
  assert.equal(v.mutation.floor, 0.6);
});

test('a partial verification block keeps the other defaults', () => {
  const v = storeWith({ verification: { mutation: { floor: 0.8 }, panel: { enabled: true } } }).config().verification;
  assert.equal(v.mutation.floor, 0.8);
  assert.equal(v.mutation.maxMutants, 20);
  assert.equal(v.mutation.enabled, false);
  assert.equal(v.panel.enabled, true);
  assert.deepEqual(v.panel.judges, []);
  assert.equal(v.oracles.seed, 1);
});
