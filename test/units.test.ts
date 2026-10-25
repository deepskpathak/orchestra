import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildArgs, extractJson, parseUsage, summarizeTool } from '../src/agent.ts';
import { detectTestCommand, summary } from '../src/cli.ts';
import { decide } from '../src/guard.ts';
import { metrics } from '../src/evolve.ts';
import { fit, renderDashboard, renderStats, renderStatusLine, sparkline, visible } from '../src/tui/render.ts';
import type { LedgerRow, Run } from '../src/types.ts';

test('guard blocks holdout access, network, harness edits, secrets', () => {
  assert.equal(decide('Read', { file_path: '/r/.orchestra/holdout/x.json' }).allow, false);
  assert.equal(decide('Bash', { command: 'cat ../../.orchestra/holdout/r1.json' }).allow, false);
  assert.equal(decide('Bash', { command: 'curl https://example.com' }).allow, false);
  assert.equal(decide('Bash', { command: 'git push origin main' }).allow, false);
  assert.equal(decide('Edit', { file_path: '/r/.orchestra/harness/v1/judge.md' }).allow, false);
  assert.equal(decide('Read', { file_path: '/r/.env' }).allow, false);
  assert.equal(decide('Edit', { file_path: '/r/src/app.ts' }).allow, true);
});

test('guard protects the installed scorer, not any scorer/ directory in the target repo', () => {
  const ctx = { cwd: '/w', scorerDir: '/pkg/scorer' };
  const d = (tool: string, input: Record<string, unknown>) => decide(tool, input, ctx).allow;
  assert.equal(d('Edit', { file_path: '/pkg/scorer/judge.md' }), false);
  assert.equal(d('Write', { file_path: '../pkg/scorer/config.json', content: '{}' }), false);
  assert.equal(d('Bash', { command: 'echo pass > /pkg/scorer/checklist.md' }), false);
  assert.equal(d('Read', { file_path: '/pkg/scorer/judge.md' }), true);
  // A project with its own scorer/ or src/scorer/ is unaffected.
  assert.equal(d('Edit', { file_path: '/w/scorer/model.py' }), true);
  assert.equal(d('Write', { file_path: 'src/scorer/index.ts', content: 'x' }), true);
  assert.equal(d('Bash', { command: 'echo x > scorer/a.txt' }), true);
  // Prose mentioning the scorer is not a scorer write.
  assert.equal(d('Write', { file_path: 'README.md', content: 'The frozen /pkg/scorer/ judges promotion.' }), true);
  // Read-only Bash on the scorer is allowed; harmless redirects do not count as writes.
  assert.equal(d('Bash', { command: 'cat /pkg/scorer/judge.md' }), true);
  assert.equal(d('Bash', { command: 'grep -r foo /pkg/scorer 2>&1' }), true);
  assert.equal(d('Bash', { command: 'cat /pkg/scorer/x > /dev/null' }), true);
  // Writes, including the previously missed forms.
  for (const command of [
    'rm /pkg/scorer/judge.md',
    'sed -i s/a/b/ /pkg/scorer/judge.md',
    'cat x | tee /pkg/scorer/checklist.md',
    'cp /tmp/x /pkg/scorer/config.json',
    'cd /pkg/scorer && echo x > judge.md',
    'git -C /pkg/scorer checkout -- judge.md',
    'echo x > /pkg/scor*/judge.md',
    'python3 -c "open(\'/pkg/scorer/judge.md\',\'w\').write(\'x\')"',
  ]) assert.equal(d('Bash', { command }), false, command);
  assert.equal(decide('Bash', { command: 'npm test' }).allow, true);
  assert.equal(decide('Edit', { file_path: '/r/src/app.ts' }).allow, true);
});

test('claude args: isolated settings, guard hook, no prompts, schema', () => {
  const args = buildArgs({ role: 'judge', prompt: 'p', system: 's', cwd: '.', model: 'opus', budgetUsd: 1, schema: { type: 'object' }, tools: ['Read'] });
  const at = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(at('--output-format'), 'stream-json');
  assert.equal(at('--setting-sources'), 'project,local');
  assert.equal(at('--permission-prompts'), 'none');
  assert.equal(at('--tools'), 'Read');
  assert.match(at('--settings'), /orchestra\.ts\\?" guard/);
  assert.equal(at('--json-schema'), '{"type":"object"}');
});

test('extractJson prefers structured output and falls back to text', () => {
  assert.deepEqual(extractJson({ ok: true, text: '', structured: { a: 1 }, costUsd: 0, turns: 0, durationMs: 0 }), { a: 1 });
  assert.deepEqual(extractJson({ ok: true, text: 'here: {"b":2} done', costUsd: 0, turns: 0, durationMs: 0 }), { b: 2 });
  assert.equal(extractJson({ ok: true, text: 'nothing', costUsd: 0, turns: 0, durationMs: 0 }), undefined);
});

test('summarizeTool shows the salient argument', () => {
  assert.equal(summarizeTool('Edit', { file_path: 'src/a.ts' }), 'Edit src/a.ts');
  assert.equal(summarizeTool('Bash', { command: 'npm   test' }), 'Bash npm test');
  assert.equal(summarizeTool('TodoWrite', {}), 'TodoWrite');
});

test('fit pads and truncates by visible width, keeping ANSI codes', () => {
  assert.equal(visible(fit('\x1b[32mhello\x1b[0m', 8)), 8);
  assert.equal(visible(fit('abcdefghij', 5)), 5);
  assert.ok(fit('abcdefghij', 5).endsWith('…'));
  assert.equal(sparkline([0, 0.5, 1]).length, 3);
});

test('dashboard renders all sections at a fixed width', () => {
  const run: Run = {
    id: 'r1', goal: 'Add dark mode', harness: 'v2', kind: 'goal', status: 'running', startedAt: 0, costUsd: 1.23,
    tasks: [
      { id: 'T1', title: 'Theme context', description: '', acceptance: [], deps: [], status: 'merged', attempts: 1, notes: [], costUsd: 0.2, verdict: { pass: true, score: 0.9, summary: '', issues: [], testsPassed: true } },
      { id: 'T2', title: 'Toggle', description: '', acceptance: [], deps: ['T1'], status: 'running', attempts: 2, notes: [], costUsd: 0.4 },
    ],
    active: [{ key: 'k', role: 'worker', task: 'T2', model: 'sonnet', startedAt: 0, lastAction: 'Edit src/Toggle.tsx', tools: 4, costUsd: 0 }],
  };
  const out = renderDashboard(run, [{ t: 1000, run: 'r1', kind: 'task.merged', msg: 'T1 merged' }], { width: 100, now: 65_000, color: false, frame: 0 });
  for (const s of ['ORCHESTRA', 'harness v2', 'Add dark mode', 'Agents (1)', 'Edit src/Toggle.tsx', 'T1', '⇠ T1', 'T1 merged', '01:05']) assert.ok(out.includes(s), s);
  for (const line of out.split('\n')) assert.equal(visible(line), 100, `line width: ${line}`);
  assert.match(renderStatusLine(run, { harness: 'v2', color: false, frame: 0 }), /1\/2 .*W:T2/);
  assert.match(renderStatusLine(null, { harness: 'v2', color: false, frame: 0 }), /idle · harness v2/);
});

test('detectTestCommand recognises common stacks', () => {
  assert.equal(detectTestCommand('/nonexistent'), null);
});

test('release metadata: MIT license, consistent package and plugin manifests', () => {
  const root = join(import.meta.dirname, '..');
  assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /MIT License/);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(plugin.license, 'MIT');
  assert.equal(pkg.version, plugin.version);
});

test('parseUsage reads full, partial and absent usage', () => {
  assert.deepEqual(
    parseUsage({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }),
    { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
  );
  assert.deepEqual(parseUsage({ usage: { input_tokens: 5, output_tokens: 'x' } }), {
    inputTokens: 5,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(parseUsage({ type: 'result' }), undefined);
});

function statsStore(rows: Partial<LedgerRow>[]) {
  const run = { id: 'r1', kind: 'goal', harness: 'v1', endedAt: 1, tasks: [], satisfaction: 0 };
  return { listRuns: () => ['r1'], loadRun: () => run, ledgerRows: () => rows.map((r) => ({ harness: 'v1', kind: 'goal', costUsd: 0, ...r })) } as any;
}

test('stats cache hit ratio: computed from usage, n/a for legacy rows', () => {
  const archive = [{ version: 'v1', status: 'promoted', evalScore: null, rationale: 'seed' }] as any;
  const withUsage = metrics(statsStore([{ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 }]));
  assert.equal(withUsage[0].cacheHitRatio, 0.6);
  assert.match(renderStats(withUsage, archive, 'v1', false), /cache hit ratio\s+v1 60%/);
  const legacy = metrics(statsStore([{}]));
  assert.equal(legacy[0].cacheHitRatio, null);
  const out = renderStats(legacy, archive, 'v1', false);
  assert.match(out, /cache hit ratio\s+v1 n\/a/);
  assert.doesNotMatch(out, /NaN/);
});

// Returns the semver-like versions a README claims as "Version X.Y[.Z]".
function readmeVersions(text: string): string[] {
  return [...text.matchAll(/\bVersion\s+v?(\d+\.\d+(?:\.\d+)?)/gi)].map((m) => m[1]);
}

// Claimed versions that differ from the package version (exact match required).
function staleReadmeVersions(readme: string, pkgVersion: string): string[] {
  return readmeVersions(readme).filter((v) => v !== pkgVersion);
}

test('README version claims match package.json', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
  assert.deepEqual(staleReadmeVersions(readme, pkg.version), []);
});

test('staleReadmeVersions flags mismatched README versions', () => {
  assert.deepEqual(staleReadmeVersions('Status\n\nVersion 0.1. Tests.', '0.6.1'), ['0.1']);
  assert.deepEqual(staleReadmeVersions('Version 0.6.0', '0.6.1'), ['0.6.0']);
  // A partial X.Y claim is not accepted as equal to X.Y.Z.
  assert.deepEqual(staleReadmeVersions('Version 0.6', '0.6.1'), ['0.6']);
  assert.deepEqual(staleReadmeVersions('Version 0.6.1', '0.6.1'), []);
  assert.deepEqual(staleReadmeVersions('No version stated', '0.6.1'), []);
});

test('run summary separates failed, blocked and needs-human tasks', () => {
  const t = (id: string, status: string, extra: object = {}) => ({ id, title: id, status, ...extra });
  const run = { id: 'r1', status: 'failed', satisfaction: 0.5, costUsd: 1, tasks: [t('T1', 'needs_human', { humanReason: 'spec vs test' }), t('T2', 'blocked'), t('T3', 'blocked'), t('T4', 'failed'), t('T5', 'merged')] } as unknown as Run;
  assert.match(summary(run), /1 failed, 2 blocked, 1 need a human/);
});

test('a skipped mutation pass renders as skipped in the summary and the dashboard, never as a score', () => {
  const base = { id: 'r1', goal: 'g', harness: 'v1', kind: 'goal', status: 'done', startedAt: 0, costUsd: 0, tasks: [], active: [] } as unknown as Run;
  const skipped: Run = { ...base, mutation: { total: 0, killed: 0, floor: 0.6, skipped: 'checks already fail without mutation' } };
  assert.match(summary(skipped), /mutation score skipped \(checks already fail without mutation\)/);
  const out = renderDashboard(skipped, [], { width: 100, now: 1, color: false, frame: 0 });
  assert.match(out, /mutation skipped \(checks already fail/);
  assert.doesNotMatch(out, /mutation 1\.00/);
  const scored: Run = { ...base, mutation: { total: 4, killed: 3, floor: 0.6, score: 0.75, pass: true } };
  assert.match(summary(scored), /mutation score 0\.75 \(3\/4 killed, floor 0\.6, pass\)/);
});

test('runTestsAsync reports exit codes, kills on timeout and does not block the event loop', async () => {
  const g = await import('../src/git.ts');
  const dir = process.cwd();
  assert.deepEqual((await g.runTestsAsync(dir, 'echo hi')).ok, true);
  const bad = await g.runTestsAsync(dir, 'echo oops >&2; exit 3');
  assert.equal(bad.ok, false);
  assert.equal(bad.exit, 3);
  assert.match(bad.tail, /oops/);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  const slow = await g.runTestsAsync(dir, 'sleep 5', 300);
  clearInterval(timer);
  assert.equal(slow.ok, false);
  assert.equal(slow.exit, null);
  assert.match(slow.tail, /timed out after 300ms/);
  assert.ok(Date.now() - t0 < 3000, 'the sleeping child was killed, not waited for');
  assert.ok(ticks >= 10, `event loop kept ticking (${ticks})`);
  // The env is honoured.
  assert.match((await g.runTestsAsync(dir, 'echo "[$FOO_X]"', 5000, { PATH: process.env.PATH, FOO_X: 'v' })).tail, /\[v\]/);
});
