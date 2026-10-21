// Simulated runner. Exercises the full conductor (worktrees, merges, repair loops,
// learning, evolution) without spending tokens. Used by tests and `orchestra demo`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRequest, AgentResult, Runner } from './agent.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeRunner(opts: { stepMs?: number; failFirstAttemptOf?: string[]; failAlways?: string[]; judgeFailTimes?: number } = {}): Runner {
  const step = opts.stepMs ?? 0;
  const failFirst = new Set(opts.failFirstAttemptOf ?? ['T2']);
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
        execFileSync('git', ['add', '-A'], { cwd: req.cwd });
        execFileSync('git', ['commit', '-qm', `${task}: attempt ${attempt}`], { cwd: req.cwd });
        return done(undefined, `Implemented ${task}`, 0.2);
      }
      case 'judge': {
        if (judgeFailsLeft > 0) {
          judgeFailsLeft -= 1;
          return { ok: false, text: '', error: 'simulated judge crash', costUsd: 0.01, turns: 1, durationMs: step, usage: { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        }
        await act('Bash git diff');
        await act('says: checking acceptance');
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
            { role: 'worker', lesson: 'Handle empty config files explicitly; judges reject missing edge cases.' },
            { role: 'planner', lesson: 'Split config and CLI work; they parallelize cleanly.' },
          ],
        });
      }
      case 'evolver': {
        await act('says: proposing variant');
        return done({
          rationale: 'Repair loops cluster on missing edge cases; make the worker enumerate edge cases before coding.',
          files: [{ name: 'worker.md', content: `${req.prompt.match(/--- worker\.md ---\n([\s\S]*?)\n\n--- /)?.[1] ?? 'You are a WORKER.'}\n- Before coding, list the edge cases and write a test for each one.\n` }],
        });
      }
    }
  };
}
