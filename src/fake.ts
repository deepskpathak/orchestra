// Simulated runner. Exercises the full conductor (worktrees, merges, repair loops,
// learning, evolution) without spending tokens. Used by tests and `orchestra demo`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRequest, AgentResult, Runner } from './agent.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeRunner(opts: { stepMs?: number; failFirstAttemptOf?: string[]; failAlways?: string[]; flagForHuman?: string[]; judgeFailTimes?: number; contrastPick?: 'A' | 'B'; contrastScores?: { a: number; b: number } } = {}): Runner {
  const step = opts.stepMs ?? 0;
  const failFirst = new Set(opts.failFirstAttemptOf ?? ['T2']);
  const flagHuman = new Set(opts.flagForHuman ?? []);
  const failAlways = new Set(opts.failAlways ?? []);
  let judgeFailsLeft = opts.judgeFailTimes ?? 0;

  return async (req: AgentRequest): Promise<AgentResult> => {
    const act = async (a: string) => {
      req.onAction?.(a);
      if (step) await sleep(step);
    };
    const done = (structured: unknown, text = 'ok', costUsd = 0.05): AgentResult => ({
      ok: true,
      text,
      structured,
      costUsd,
      turns: 3,
      durationMs: step * 3,
      usage: { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 800 },
    });
    const task = req.meta?.task ?? '';
    const attempt = req.meta?.attempt ?? 1;

    switch (req.role) {
      case 'planner': {
        await act('Glob **/*');
        await act('Read package.json');
        await act('says: drafting task graph');
        return done(
          {
            tasks: [
              { id: 'T1', title: 'Core module', description: 'Create core module', acceptance: ['core.txt exists'], deps: [] },
              { id: 'T2', title: 'Config loader', description: 'Load config', acceptance: ['config.txt exists'], deps: [] },
              { id: 'T3', title: 'CLI wiring', description: 'Wire CLI to core', acceptance: ['cli.txt exists'], deps: ['T1'] },
              { id: 'T4', title: 'Docs', description: 'Document usage', acceptance: ['docs.txt exists'], deps: ['T2', 'T3'] },
            ],
            domain: 'cli',
            scenarios: [{ id: 'S1', given: 'a fresh repo', when: 'user runs the CLI', then: 'it prints help' }],
          },
          'planned',
          0.12,
        );
      }
      case 'worker': {
        await act(`Read src/${task}.ts`);
        await act(`Edit src/${task}.ts`);
        await act('Bash npm test');
        const dir = join(req.cwd, 'fake');
        mkdirSync(dir, { recursive: true });
        // Workers running an evolved prompt that asks for edge cases leave a marker the judge rewards.
        const careful = /edge cases/i.test(req.system);
        writeFileSync(join(dir, `${task}.txt`), `task ${task} attempt ${attempt}${careful ? ' edge-cases-covered' : ''}\n`);
        // Contrastive worker B leaves a distinguishable artifact.
        if (req.meta?.variant === 'b') writeFileSync(join(dir, `${task}-b.txt`), `task ${task} alternate approach B\n`);
        execFileSync('git', ['add', '-A'], { cwd: req.cwd });
        execFileSync('git', ['commit', '-qm', `${task}: attempt ${attempt}`], { cwd: req.cwd });
        if (flagHuman.has(task)) {
          return done({ outcome: 'flag_for_human', reason: `Spec and tests contradict each other for ${task}` }, `FLAG_FOR_HUMAN: Spec and tests contradict each other for ${task}`, 0.2);
        }
        return done(undefined, `Implemented ${task}`, 0.2);
      }
      case 'judge': {
        if (req.prompt.startsWith('FROZEN SCORER REPLAY')) {
          // Frozen scorer: judges the diff, never the replay's self-reported satisfaction.
          await act('says: scoring replay');
          const careful = /edge-cases-covered/.test(req.prompt);
          const empty = /DIFF:\n\(empty\)/.test(req.prompt);
          return done(empty ? { pass: false, score: 0.2, summary: 'No change' } : { pass: true, score: careful ? 0.95 : 0.85, summary: 'Meets goal' }, 'scored', 0.04);
        }
        if (judgeFailsLeft > 0) {
          judgeFailsLeft -= 1;
          return { ok: false, text: '', error: 'simulated judge crash', costUsd: 0.01, turns: 1, durationMs: step, usage: { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        }
        await act('Bash git diff');
        await act('says: checking acceptance');
        if (/ATTEMPT A DIFF/.test(req.prompt)) {
          const pick = opts.contrastPick ?? 'B';
          const sc = opts.contrastScores ?? { a: 0.85, b: 0.9 };
          const side = (n: number) => ({ pass: n >= 0.7, score: n, summary: n >= 0.7 ? 'Meets criteria' : 'Falls short', issues: n >= 0.7 ? [] : ['Handle empty config file'] });
          return done({ a: side(sc.a), b: side(sc.b), preferred: pick, reasons: `Attempt ${pick} handled the empty config case more directly.` }, 'compared', 0.08);
        }
        let careful = false;
        try {
          careful = readFileSync(join(req.cwd, 'fake', `${task}.txt`), 'utf8').includes('edge-cases-covered');
        } catch {
          // No artifact: the worker produced nothing for this task.
        }
        const fail = failAlways.has(task) || (failFirst.has(task) && attempt === 1 && !careful);
        return done(
          fail
            ? { pass: false, score: 0.4, summary: 'Missing edge case', issues: ['Handle empty config file'] }
            : { pass: true, score: Math.min(1, 0.8 + (task.charCodeAt(1) % 10) / 100 + (careful ? 0.1 : 0)), summary: 'Meets criteria', issues: [] },
          'judged',
          0.06,
        );
      }
      case 'librarian': {
        await act('says: distilling lessons');
        return done({
          lessons: [
            { role: 'worker', lesson: 'Handle empty config files explicitly; judges reject missing edge cases.', evidence: [{ run: req.meta?.run ?? 'fake-run', task: 'T2' }] },
            { role: 'planner', lesson: 'Split config and CLI work; they parallelize cleanly.', evidence: [{ run: req.meta?.run ?? 'fake-run' }] },
          ],
        });
      }
      case 'evolver': {
        const base = req.prompt.match(/--- worker\.md ---\n([\s\S]*?)\n\n--- /)?.[1] ?? 'You are a WORKER.';
        const edge = '- Before coding, list the edge cases and write a test for each one.';
        if (req.prompt.startsWith('COMPOSE VARIANTS')) {
          await act('says: composing variants');
          return done({
            variants: [{ rationale: 'Composition of the surviving variants, keeping the edits with evidence.', files: [{ name: 'worker.md', content: `${base}\n${edge}\n- composed: merged edits from surviving variants.\n` }] }],
          });
        }
        await act('says: proposing variant');
        const k = Math.max(1, Number(req.prompt.match(/PROPOSE (\d+) VARIANTS/)?.[1] ?? 1));
        const variants = [];
        for (let i = 1; i <= k; i++) {
          // Variant 1 keeps the classic edge-case edit; the rest append distinct lines so each is a different candidate.
          variants.push(
            i === 1
              ? { rationale: 'Repair loops cluster on missing edge cases; make the worker enumerate edge cases before coding.', files: [{ name: 'worker.md', content: `${base}\n${edge}\n` }] }
              : { rationale: `Variant ${i}: target a different weakness (focus area ${i}).`, files: [{ name: 'worker.md', content: `${base}\n${edge}\n- Focus area ${i}: double-check the change against the task before finishing.\n` }] },
          );
        }
        return done({ variants });
      }
    }
  };
}
