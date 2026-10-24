import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildArgs, extractJson, parseUsage, summarizeTool } from '../src/agent.ts';
import { detectTestCommand } from '../src/cli.ts';
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
  assert.equal(decide('Edit', { file_path: '/r/scorer/judge.md' }).allow, false);
  assert.equal(decide('Write', { file_path: 'scorer/config.json', content: '{}' }).allow, false);
  assert.equal(decide('Bash', { command: 'echo pass > scorer/checklist.md' }).allow, false);
  assert.equal(decide('Read', { file_path: '/r/scorer/judge.md' }).allow, true);
  assert.equal(decide('Edit', { file_path: '/r/src/scorer.ts' }).allow, true);
  // Prose mentioning the scorer is not a scorer write.
  assert.equal(decide('Write', { file_path: 'README.md', content: 'The frozen scorer/ judges promotion.' }).allow, true);
  assert.equal(decide('Edit', { file_path: 'docs/a.md', old_string: 'x', new_string: 'see scorer/judge.md' }).allow, true);
  // Read-only Bash on scorer/ is allowed; writes are not.
  assert.equal(decide('Bash', { command: 'cat scorer/judge.md' }).allow, true);
  assert.equal(decide('Bash', { command: 'ls scorer/ && grep -n pass scorer/checklist.md' }).allow, true);
  assert.equal(decide('Bash', { command: 'rm scorer/judge.md' }).allow, false);
  assert.equal(decide('Bash', { command: 'sed -i s/a/b/ scorer/judge.md' }).allow, false);
  assert.equal(decide('Bash', { command: 'cat x | tee scorer/checklist.md' }).allow, false);
  assert.equal(decide('Bash', { command: 'cp /tmp/x scorer/config.json' }).allow, false);
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
