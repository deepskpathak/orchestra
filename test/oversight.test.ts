import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_IDENTITIES, canApprove, classifyRisk, DEFAULT_RISK_TIERS, matchGlob, oversightMetrics } from '../src/oversight.ts';

const risk = (changedFiles: string[], diffLines = 10, deterministicGreen = false) =>
  classifyRisk({ changedFiles, diffLines, deterministicGreen }, DEFAULT_RISK_TIERS);

test('defaults are disabled', () => {
  assert.equal(DEFAULT_RISK_TIERS.enabled, false);
  assert.equal(DEFAULT_RISK_TIERS.largeDiffLines, 400);
});

test('matchGlob', () => {
  assert.equal(matchGlob('docs/**', 'docs/a/b.txt'), true);
  assert.equal(matchGlob('**/*.md', 'README.md'), true);
  assert.equal(matchGlob('**/*.md', 'a/b/c.md'), true);
  assert.equal(matchGlob('*.md', 'a/b.md'), false);
  assert.equal(matchGlob('src/?.ts', 'src/a.ts'), true);
  assert.equal(matchGlob('a.b', 'axb'), false);
});

test('classifyRisk tiers', () => {
  assert.equal(risk(['docs/guide.md', 'README.md', 'test/x.test.ts']).tier, 'low');
  assert.equal(risk(['src/auth/login.ts']).tier, 'high');
  assert.equal(risk(['infra/main.tf']).tier, 'high');
  assert.equal(risk(['.github/workflows/ci.yml']).tier, 'high');
  assert.equal(risk(['docs/a.md'], 401).tier, 'high');
  assert.equal(risk(['src/auth/login.ts', 'docs/a.md'], 5, true).tier, 'high');
  assert.equal(risk(['src/a.ts'], 20, true).tier, 'low');
  assert.equal(risk(['src/a.ts'], 20, false).tier, 'normal');
  assert.ok(risk(['src/auth/login.ts']).reasons.length > 0);
});

test('canApprove', () => {
  assert.equal(canApprove({ approver: 'alice', requester: 'bob' }).ok, true);
  assert.equal(canApprove({ approver: 'alice', requester: 'bob', approverKind: 'human' }).ok, true);
  assert.equal(canApprove({ approver: '', requester: 'bob' }).ok, false);
  assert.equal(canApprove({ approver: 'Bob', requester: 'bob' }).ok, false);
  assert.equal(canApprove({ approver: '  BOB ', requester: 'bob' }).ok, false);
  assert.equal(canApprove({ approver: 'alice', requester: 'bob', approverKind: 'agent' }).ok, false);
  for (const a of AGENT_IDENTITIES) assert.equal(canApprove({ approver: a.toUpperCase(), requester: 'bob' }).ok, false, a);
  for (const a of ['planner', 'worker', 'judge', 'librarian', 'evolver', 'orchestra']) assert.ok(AGENT_IDENTITIES.includes(a));
});

test('oversightMetrics', () => {
  assert.deepEqual(oversightMetrics([]), []);
  assert.deepEqual(oversightMetrics([{ runId: 'r1', taskId: 'T1' }]), [{ runId: 'r1', interruptions: 0, reviewMinutes: 0, edits: 0 }]);
  const m = oversightMetrics([
    { runId: 'r1', needsHuman: true },
    { runId: 'r1', requestedAt: '2026-01-01T00:00:00Z', decidedAt: '2026-01-01T00:12:30Z', humanCommits: 2 },
    { runId: 'r1', requestedAt: '2026-01-01T01:00:00Z' },
    { runId: 'r2', requestedAt: '2026-01-01T00:00:00Z', decidedAt: '2026-01-01T00:05:00Z' },
  ]);
  assert.deepEqual(m[0], { runId: 'r1', interruptions: 3, reviewMinutes: 12.5, edits: 2 });
  assert.deepEqual(m[1], { runId: 'r2', interruptions: 1, reviewMinutes: 5, edits: 0 });
});
