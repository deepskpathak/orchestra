# One agent writes the code. Another one never lets it see the test.

*How we built Orchestra, a self-improving multi-agent software factory on top of Claude Code.*

We kept running into the same wall with coding agents. Give one agent a big goal and it plans, builds, reviews its own work, and tells you it is done. Sometimes it is. Often the "review" is the author grading its own homework.

So we built Orchestra. This post covers what it is, how a run works, how it tries to get better over time, and where it falls short. For the long version with design detail and threats to validity, read the [whitepaper](../whitepaper-orchestra.md).

## The problem with one agent doing everything

A single long session has three weaknesses we kept hitting:

- **One context for everything.** Planning, coding and reviewing all pile into one conversation, so early mistakes leak into later judgment.
- **The author is the reviewer.** An agent that wrote the code tends to check it against what it already believes.
- **No memory across runs.** Whatever went wrong last time is gone next time, unless you remember to write it down.

None of this is exotic. It is how a team would fail if one person did every job and never held a retro.

## What Orchestra is

Orchestra is a factory built on Claude Code. You give it a goal. It:

1. plans a task graph,
2. builds tasks in parallel git worktrees,
3. verifies each one with tests plus an independent judge working from hidden scenarios,
4. repairs what fails,
5. merges through a queue, one at a time by default,
6. records what it learned,
7. and periodically evolves its own prompts and config.

There are five roles: planner, worker, judge, librarian and evolver. Each gets fresh context per attempt. Planners never code and judges never edit. Durable state lives in git and a `.orchestra/` directory, not in a long conversation.

## How a run works

**Plan.** The planner reads the goal, the tracked file list, the test command and past learnings. It returns a task graph with dependencies and acceptance criteria. It also returns scenarios in given/when/then form.

**Build.** Each task gets its own branch and worktree, so parallel workers cannot trip over each other. Your checkout is never touched.

**Verify.** The scenarios are written to a holdout file outside every worktree. Workers never see them. Only the judge does. We enforce this in code, not just in a prompt: a PreToolUse hook denies any tool call that mentions the holdout directory. The same hook blocks network commands, pushes, and edits to the harness and evals.

A task passes only if the judge says pass, the score meets the pass threshold (0.75 by default), and the project tests did not fail.

**Repair.** When a task fails, the judge's issues become repair notes and a fresh worker tries again, up to `maxAttempts` (3 by default). Merge conflicts and red post-merge tests also send a task back. After the limit, the task is marked failed and anything depending on it is blocked.

**Contrastive repair (opt-in).** In a repo without a `testCommand`, the judge is the only signal, so a repair attempt can be a coin flip. With the `contrastive` setting on, two workers try the task in separate worktrees, one following the repair notes and one taking a different approach. One comparison judge call picks a winner, the loser is deleted, and the judge's reasons go to the librarian as evidence. It is off by default.

**Stronger verification (opt-in).** A `verification` block adds a judge panel, an agentic judge mode where the conductor runs the scenario check commands and the tests before judging and hands the results to the judge, frozen acceptance contracts, oracle tests written by a separate session, and a mutation score per run. All are off by default and none has been measured on real runs yet.

**Merge.** By default, passing tasks queue up and merge one at a time onto `orchestra/<run>/integration`, with tests after each merge. A failing merge is reset. An opt-in batch merge (`throughput.batchMerge`) lands tasks with disjoint footprints together with one test run per batch, and bisects a failing batch.

**Learn.** The librarian turns repairs and failures into lessons. The planner tags each run with a short domain slug such as `cli` or `docs`, and lessons are stored per domain plus a global set. Every lesson must cite evidence (the run or task behind it), or it is dropped. Each domain keeps at most 25 lessons, and prompts get at most 15, domain first and then global.

## How the factory improves itself

Orchestra records every agent session in a ledger. `orchestra stats` reports health per harness version: runs, tasks, merged tasks, first-pass yield, satisfaction, and cost per merged task.

The harness is the evolvable part: role prompts, `config.json`, and three small optional files (`tools.md`, `style.md`, `checklist.md`). `orchestra evolve` runs one cycle:

1. The evolver studies the metrics, recent repair notes, rejected variants and learnings, then proposes a variant.
2. A Factory Eval replays past goals against the incumbent and then the candidate. Runs that finished well are harvested automatically. You can also add cases by hand (`orchestra evals add`) or turn a failed run plus your fix commit into a case (`evals add --from-run <runId> --fix <commit>`), where the fix diff becomes the reference.
3. The candidate is promoted only if it beats the incumbent by at least `evolve.minGain` and regresses no case the incumbent passed.

With `evolve.candidates` above 1, the evolver proposes several variants, screens each on a small sample, composes the survivors, and runs the usual decision on the result. Versions are append-only, so rollback is just `orchestra promote v1`.

More controls are opt-in and off by default: time-split eval sets with a locked holdout the evolver never sees (`evolve.splits`), a leakage audit for repos that keep an eval set (`orchestra evals audit`; `evals add` already refuses leaky cases), cascade screening, sequential testing with a per-cycle budget cap, cost in the objective, and a Pareto archive for picking parents.

Some rails are not negotiable. The evolver cannot edit its own prompt. It cannot lower `passThreshold`. It cannot remove lines from the review checklist. The design borrows the archive idea from the Darwin Godel Machine, as noted in `docs/self-improvement.md`.

## Watching it work

You can follow a run four ways, all reading the same `run.json` and `events.jsonl`:

- `orchestra watch` for a full-screen live terminal view.
- `orchestra status` for a one-shot board.
- `orchestra serve` for a read-only localhost web dashboard, with a task board, SVG dependency arrows, a Flow view, live agent lanes, and a task drawer showing criteria, judge score, diff and logs.
- `orchestra serve --tui` (or `orchestra tui`) for an interactive terminal dashboard that needs no browser and no port.

There is also a Claude Code statusline.

## An example run

You can try a run for free: `orchestra demo` uses a simulated runner in a temporary repo, so no tokens are spent. The simulator's planner always returns the same four tasks (a core module, a config loader, CLI wiring that depends on the core, and docs that depend on the other two), and it makes the config loader fail its first attempt on purpose so you can watch a repair.

With a real goal, such as the one from our README:

```bash
orchestra run "Add a --json flag to the export command"
```

the stages go like this:

1. **Plan.** The planner proposes tasks with acceptance criteria and hidden scenarios.
2. **Build.** Independent tasks start together in their own worktrees. Dependent ones wait.
3. **Verify.** Tests run, then the judge scores each diff against criteria and the scenarios it alone can see.
4. **Repair.** If a task is rejected, a new worker gets the judge's notes and tries again.
5. **Merge.** Passing tasks land on the integration branch, one at a time by default.
6. **Learn.** The librarian records lessons for next time.

The dashboard looks roughly like this (illustrative output, not from a measured run):

```
│ ✓ T1   merged   Core module                                    │
│ ⠸ T2   running  Config loader        try 2                     │
│ ⠸ T3   judging  CLI wiring ⇠ T1                                │
```

Results land on `orchestra/<run>/integration`. You review with `git log main..orchestra/<run>/integration` and land it with `git merge`. Nothing reaches your branch until you say so.

## What it does not do yet

We would rather be upfront:

- **No published benchmarks.** We have not run a controlled comparison against a single agent, and we are not going to quote numbers we do not have. The whitepaper describes how we would measure it.
- **Sandboxing is opt-in and untested against real backends.** By default workers share one machine, and the guard hook is a backstop, not a sandbox. `--sandbox` confines workers with srt, Claude Code's sandbox (`bwrap` or `sandbox-exec`) or docker, scrubs credentials from their environment and runs pre-flight probes before the first agent call. Our tests use fakes, so none of these backends has been exercised against the real tool yet.
- **Evolution is expensive.** It reruns past goals, so one cycle costs roughly `sample x 2` runs plus the evolver call. Tune `evolve.sample`, `evolve.every` and `evolve.candidates`.
- **Early days.** The test suite runs against the simulator, so it exercises the pipeline but says nothing about real-model quality.
- **Judges can be wrong.** Hidden scenarios and tests raise the bar. They do not make the verdict ground truth.

## Try it

You need Node 23.6 or newer (it runs TypeScript directly, no build step), git, and Claude Code with headless auth working. `orchestra doctor` checks it.

**1. Try the demo (no tokens spent):**

```bash
node <path-to-orchestra>/bin/orchestra.ts demo
```

**2. Install.** As a Claude Code plugin:

```bash
claude plugin marketplace add <path-to-orchestra>
claude plugin install orchestra@orchestra-local
```

Or as a CLI in any terminal:

```bash
cd <path-to-orchestra> && npm link
```

**3. Initialise a repo.** From inside a git repo:

```bash
orchestra init
```

**4. First run:**

```bash
orchestra run "Add a --json flag to the export command"
```

If you try it, tell us where it breaks. For the full design, evaluation method and threats to validity, read the [whitepaper](../whitepaper-orchestra.md).
