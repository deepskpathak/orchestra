# Architecture

For the design rationale, see the [whitepaper](whitepaper-orchestra.md).

Orchestra turns a goal into merged, reviewed code by running five agent roles around git. All durable state lives in git and in a `.orchestra/` directory, never in a long conversation (see `src/agent.ts`).

```
goal
  |
planner --> task graph + hidden scenarios (holdout/<run>.json)
  |
  +--> worker (task A, own worktree)  --\
  +--> worker (task B, own worktree)  ---+--> tests + judge --> merge queue --> integration branch
  +--> worker (task C, waits on A)    --/        |  fail
                                                 +--> repair notes --> next worker attempt
  |
librarian --> learnings.json (read by the next run)
```

The frozen scorer (`scorer/`, loaded by `src/scorer.ts`) and the integrity monitor (`src/integrity.ts`) sit outside the evolvable harness. The scorer grades eval replays for promotion, and the monitor inspects worker diffs for grading-surface edits, weakened tests and reward hacks. The evolver cannot edit or see either.

The evolver sits outside the run loop. It proposes changes to the factory itself (see [self-improvement](self-improvement.md)).

## The five roles

Each role is a system prompt in `harness/v1/<role>.md`. Models and limits come from `harness/v1/config.json`, which sets `models`, `maxAttempts`, `passThreshold` and a per-role `budgetUsd`. The shipped defaults are:

| Role | Prompt | Default model | What it does |
|------|--------|---------------|--------------|
| planner | `harness/v1/planner.md` | opus | Reads the goal, the tracked file list, the test command and learnings. Returns a task graph (with dependencies and acceptance criteria) plus hidden scenarios. Read-only tools. |
| worker | `harness/v1/worker.md` | sonnet | Implements one task inside that task's worktree. Gets the goal, its task, acceptance criteria, the other tasks' titles, learnings and any repair notes. |
| judge | `harness/v1/judge.md` | opus | Scores the diff against acceptance criteria and the hidden scenarios. Returns pass, a 0 to 1 score, a summary and issues. Any edits it makes are discarded. |
| librarian | `harness/v1/librarian.md` | sonnet | After a goal run, distills repairs and failures into lessons for the planner, worker and judge. No tools. |
| evolver | `harness/v1/evolver.md` | opus | Proposes an improved harness variant. May edit the other four prompts and `config.json`, not its own prompt. |

The conductor (`src/conductor.ts`) drives the first four in sequence: plan, schedule workers, judge, merge, then learn. The learn step runs only for goal runs, not eval runs.

## Git worktrees and the integration branch

`src/git.ts` keeps your checkout untouched. For each run it creates:

- An **integration branch** `orchestra/<run>/integration`, cut from the base ref (HEAD unless a base is given), checked out in `.orchestra/worktrees/<run>/_integration`.
- A **task branch** `orchestra/<run>/<task>` and worktree `.orchestra/worktrees/<run>/<task>` per task, cut from the integration tip when the attempt starts.

Workers run with their worktree as the working directory, so parallel tasks cannot trip over each other. `.orchestra/` is added to `.git/info/exclude` rather than your tracked `.gitignore`. The repo needs at least one commit. When a run ends the worktrees are removed; the integration branch stays, and the CLI prints how to review (`git log`) and land (`git merge`) it.

## Hidden holdout scenarios

The planner returns scenarios in given/when/then form alongside the tasks. The conductor writes them to `holdout/<run>.json` under `.orchestra/`, outside every worktree. Workers are never given them. Only the judge prompt includes them, and the judge is told to assess just the parts a given task is responsible for.

This is enforced in code, not only by prompt. The OS sandbox (when enabled) denies reads of the holdout directory, and the guard hook in `src/guard.ts` is injected into every agent session as a backstop that denies any tool call whose input mentions it. It also blocks writes to the harness, evals and archive, network commands, `git push`, `npm publish` and common secret files.

## Boundary model: OS sandbox first, guard hook as backstop

The real isolation boundary is OS-level confinement, which is opt-in: `--sandbox auto|srt|claude` (or `--unattended`) wraps each worker with `srt`, or with Claude Code `sandbox` settings backed by `bwrap` + `socat` (Linux) or `sandbox-exec` (macOS), and `--sandbox docker` runs workers in a container (`--network=none`, optionally gVisor). The sandbox allow-lists writes (worktree and temp), denies reads of credential directories, `.env*` and the holdout, and limits the network to the model API plus `sandbox.allowedHosts`.

The `src/guard.ts` PreToolUse hook is **defence in depth**, a deny-list backstop that stays on. It matches command text and paths, so `python`, `node`, git remotes or DNS can bypass it. Do not treat it as isolation.

Around the sandbox:

- **Pre-flight self-test.** Before the first agent call the conductor checks, inside the same wrapper, that a blocked host and a denied path really fail. If either probe succeeds, the run aborts.
- **Env scrubbing.** Git-hosting, registry and cloud credentials are removed from the agent environment.
- **Read-only git hooks and config.** `.git/hooks` and `.git/config` are read-only to workers.
- **Orchestrator-only publishing.** Commit, merge, push and PR creation stay in the orchestrator; workers do not publish.
- **`--unattended` refuses to start** (exit 1, before any agent call) when no backend is found.
- **Detect and degrade.** Missing `srt`, `bwrap`, `socat`, `sandbox-exec` or `docker` is detected, not assumed. Without a backend, attended runs continue unsandboxed and rely on the hook alone.
- **Caveats.** `srt` is a research preview. Setup varies by OS; on Linux, `bwrap` needs unprivileged user namespaces, which some distributions disable.

See [isolation.md](isolation.md) for the docker backend and the pre-flight details.

## The attempt and retry loop

For each task (`attempt()` in `src/conductor.ts`):

1. Create the task worktree and run the worker. Anything left uncommitted is committed.
2. If nothing changed, the verdict is an automatic fail with a repair note.
3. Otherwise run the project `testCommand` (if set) and the judge.
4. A task passes only if the judge says pass, the score is at least `passThreshold` (0.75 by default), and the tests did not fail.
5. On failure the verdict issues become repair notes and the task goes back to `repair` for another worker attempt. After `maxAttempts` (3 by default) it is marked `failed`, and tasks that depend on it become `blocked`.

If a worker finds that the spec and the tests contradict each other, it ends with `FLAG_FOR_HUMAN: <reason>`. That is a stop condition: no judge, no repair attempts, the task becomes `needs_human` with the reason stored on `humanReason` and a `task.needs_human` event, and dependents are `blocked`. It does not count toward repair exhaustion, and the run summary reports `needs_human` tasks separately from `failed` ones.

The integrity monitor runs on each worker diff before the judge. If a grading file that existed at the base was edited, tests are re-run with the originals restored and the attempt goes to repair with an automatic `[integrity-monitor]` note. Flags are kept on `task.integrityFlags`.

Task states are `pending`, `running`, `judging`, `repair`, `merging`, `merged`, `failed`, `needs_human` and `blocked`. Tasks start in dependency order, up to `concurrency` at a time, until `runBudgetUsd` is spent.

## Merge queue

Passing tasks enter a queue that serializes merges into the integration branch (`enqueueMerge` and `mergeOne`). Each merge is a `--no-ff` merge. Two things send a task back for repair instead of landing:

- A merge conflict. The merge is aborted and the task restarts on the latest integration tip.
- A failing `testCommand` after the merge. The integration branch is reset to its previous head.

Run satisfaction is the mean judge score of merged tasks, scaled by the fraction of tasks that merged. A run is `done` only if every task merged.

## State under .orchestra/

`src/store.ts` owns the layout. Writes go to a temp file and are renamed, so the dashboards can read while a run is writing. Shapes are defined in `src/types.ts`.

| Path | Contents |
|------|----------|
| `config.json` | Project config (concurrency, test command, tools, budgets, evolve settings) |
| `current` | Id of the active run |
| `runs/<run>/run.json` | The `Run`: goal, tasks, verdicts, active agents, cost |
| `runs/<run>/events.jsonl` | Append-only event log, one JSON event per line |
| `holdout/<run>.json` | Hidden scenarios for the judge |
| `ledger.jsonl` | One row per agent session: role, model, cost, duration, outcome |
| `learnings.json` | Librarian lessons |
| `worktrees/` | Git worktrees for the run in flight |

Harness versions, evals and an archive also live here, covered in [self-improvement](self-improvement.md).

Event kinds are `run.start`, `run.end`, `plan`, `task.start`, `task.verdict`, `task.repair`, `task.merged`, `task.failed`, `task.needs_human`, `agent.start`, `agent.action`, `agent.end`, `learn`, `evolve` and `log`. The terminal and web dashboards are views over `run.json` and `events.jsonl`.
