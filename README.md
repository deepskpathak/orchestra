# ♫ Orchestra

A self-improving, self-evaluating, self-correcting multi-agent software factory built on Claude Code.

You give it a goal. It plans a task graph, builds tasks in parallel git worktrees, verifies each one with tests plus an independent judge working from hidden scenarios, repairs what fails, merges through a serialized queue, writes down what it learned, and periodically evolves its own prompts and config. Promotion happens only when a measured eval shows a gain.

```
╭─ ♫ ORCHESTRA  r20261021-2022-77o1  harness v1 ──────────────────────────────── 00:01 ─╮
│ Goal Build a tiny CLI with config loading and docs                                     │
│ ✓ PLAN  ─  · BUILD  ─  ▶ VERIFY  ─  · MERGE  ─  · LEARN                                │
│ ███████░░░░░░░░░░░░░░░░░░░ 1/4  ✓1 ●2 ⟳0 ✗0  $1.04  RUNNING                            │
├─ Agents (2) ───────────────────────────────────────────────────────────────────────────┤
│ ⠸ judge     T3   opus · 1 tools · 00:00  Bash git diff                                 │
│ ⠼ worker    T2   sonnet · 3 tools · 00:00  Edit src/config.ts                          │
├─ Tasks ────────────────────────────────────────────────────────────────────────────────┤
│ ✓ T1   merged   ███████░ 0.89  try 1  $0.26  Core module                               │
│ ⠸ T2   running  ███░░░░░ 0.40  try 2  $0.46  Config loader                             │
│ ⠸ T3   judging  ░░░░░░░░ ----  try 1  $0.20  CLI wiring ⇠ T1                           │
│ ◌ T4   pending  ░░░░░░░░ ----  try -  $0.00  Docs ⇠ T2,T3                              │
├─ Events ───────────────────────────────────────────────────────────────────────────────┤
│ 00:01 T2 FAIL 0.40: Missing edge case                                                  │
│ 00:01 T2 -> repair: Handle empty config file                                           │
╰────────────────────────────────────────────────────────────────────────────────────────╯
```

## Try it in 10 seconds (no tokens spent)

```bash
node bin/orchestra.ts demo
```

This runs the whole pipeline with a simulated runner in a temporary repo, with the live dashboard, a repair loop, learning, and an evolution cycle that promotes `v2`.

## Install

Requirements: Node 23.6 or newer (runs TypeScript directly, so there's no build step), git, and Claude Code with headless auth working (`orchestra doctor` checks it).

**As a Claude Code plugin** (adds the `/orchestra:*` commands and puts `orchestra` on the Bash tool's PATH):

```bash
claude plugin marketplace add /Users/deepak/Workspace/projects/software-factory
```

```bash
claude plugin install orchestra@orchestra-local
```

For development, `claude --plugin-dir /Users/deepak/Workspace/projects/software-factory` loads it for one session.

**As a CLI in any terminal:**

```bash
npm link
```

## Use

| In Claude Code | In a terminal | What it does |
|---|---|---|
| `/orchestra:setup` | `orchestra init` | Creates `.orchestra/`, detects the test command, offers the statusline |
| `/orchestra:run <goal>` | `orchestra run "<goal>"` | Full factory run. Shows the live dashboard on a TTY and progress lines otherwise |
| `/orchestra:serve` | `orchestra serve` | Read-only web dashboard on localhost (default 4317): live runs, task diffs, verdicts, logs |
| `/orchestra:status` | `orchestra status` | One-shot board |
| | `orchestra watch` | Full-screen live dashboard (run it in a second terminal tab) |
| `/orchestra:stats` | `orchestra stats` | Self-evaluation: health per harness version and trends |
| `/orchestra:evolve` | `orchestra evolve` | Force a self-improvement cycle |
| | `orchestra learnings`, `evals`, `promote vN`, `doctor` | Inspect and control |

Results land on `orchestra/<run>/integration`. Your checkout is never touched. To review: `git log main..orchestra/<run>/integration`. To land: `git merge` that branch.

**Statusline.** Plugins can't ship one, so add it to `~/.claude/settings.json` (`/orchestra:setup` offers to do this):

```json
{ "statusLine": { "type": "command", "command": "/abs/path/to/bin/orchestra statusline", "refreshInterval": 2 } }
```

## How it works

```
goal ─▶ PLANNER (opus, read-only) ─▶ task graph + hidden scenarios (.orchestra/holdout)
          │
          ▼  ready tasks (deps merged), N in parallel, each in its own worktree
        WORKER (sonnet, fresh session per attempt) ─▶ commit
          │
          ▼
        tests ─▶ JUDGE (opus, never edits, sees holdout) ─▶ verdict {pass, score, issues}
          │ fail: repair notes ─▶ new WORKER attempt (max 3)        [self-correcting]
          ▼ pass
        REFINERY merge queue ─▶ post-merge tests ─▶ conflict or red? revert + repair
          ▼
        LIBRARIAN ─▶ learnings.json, fed to the next planner/worker  [compounding]
          ▼
        harvest ─▶ Factory Eval case (if satisfaction ≥ 0.8)
          ▼ every N runs
        EVOLVER ─▶ harness vN+1 ─▶ eval vs incumbent ─▶ promote only on gain, no regressions
                                                                     [self-improving]
```

**Self-evaluating.** Every agent session is a row in `.orchestra/ledger.jsonl`. `orchestra stats` aggregates per harness version: first-pass yield, satisfaction, cost per merged task, and eval score.

**Self-correcting.** There are three automatic loops:

- Judge rejections send repair notes to a fresh worker.
- Merge conflicts reset the task onto the latest code.
- Red post-merge tests revert the merge.

In all three cases the task is retried. After `maxAttempts` failures it's marked failed, and the tasks that depend on it are marked blocked.

**Self-improving.** The harness (role prompts plus `config.json`) is versioned under `.orchestra/harness/vN`. The evolver proposes one focused change. Both the candidate and the incumbent run the same Factory Eval cases from pinned base commits. The candidate is promoted only if it beats the incumbent by `minGain` with no case regressing. Every variant stays in `archive.json`. To roll back, run `orchestra promote v1`.

Each idea comes from a published factory:

| Idea | Source |
|---|---|
| Fresh context per unit of work | Anthropic long-running harness, Ralph loop |
| Planners never code, judges decide done | Cursor |
| Holdout scenarios and a satisfaction score | StrongDM |
| Refinery merge queue | Gas Town |
| Compound learnings | Every |
| Archive-based self-modification | Darwin Gödel Machine |

## Safety rails (enforced by code, not prompts)

- Agent sessions run with `--setting-sources project,local` (your personal plugins and hooks don't leak in) and `--permission-prompts none` (nothing hangs waiting for a human). Each session has a per-role `--max-budget-usd` cap.
- A PreToolUse guard hook in every session blocks:
  - reading the holdout scenarios
  - network commands, `git push`, and publishing
  - edits to the harness, evals, or archive
  - secret files
- Judges get read-only tools. Any change a judge makes is discarded.
- The evolver can't edit `evolver.md`, can't lower `passThreshold`, and can't touch the evals.
- Each run has a budget (`runBudgetUsd`, default $20). Unstarted tasks fail once it's spent.
- Everything is reversible: work goes to `orchestra/<run>/*` branches and harness versions are append-only.

## Configuration (`.orchestra/config.json`)

```json
{
  "concurrency": 3,
  "testCommand": "npm test --silent",
  "permissionMode": "acceptEdits",
  "runBudgetUsd": 20,
  "evolve": { "every": 3, "autoPromote": true, "minGain": 0.02, "sample": 3 }
}
```

Per-role models, attempts, pass threshold, and budgets live in the harness `config.json`, so the evolver can tune them.

## Layout

```
bin/orchestra(.ts)     CLI entry; bin/ is on the plugin's Bash PATH
src/conductor.ts       plan, schedule, attempt, judge, merge queue, learn
src/evolve.ts          metrics, Factory Eval, evolver, promotion
src/agent.ts           claude -p stream-json runner, guard injection
src/tui/render.ts      dashboard, statusline, stats (pure functions)
src/guard.ts           PreToolUse policy
src/fake.ts            simulated runner for tests and demo
harness/v1/            seed prompts and config (copied into .orchestra on init)
skills/                /orchestra:run, status, stats, evolve, setup
test/                  node --test suites (npm test)
```

## Status and limits (v0.1)

- Verified with the simulator: 17 tests cover the happy path, repair, failure blocking, merge conflicts, red tests, planner crash, the evolution promote and reject paths, guard rails, and rendering. Strict `tsc` passes.
- **Not yet verified against real Claude sessions** on this machine, because headless auth had expired (`Failed to authenticate: OAuth session expired`). Run `claude`, then `/login`, then `orchestra doctor`.
- Workers share one machine. There are no containers or digital twins yet. Those come in Phase 2 of `PLAN.md`.
- Evaluation reruns past goals, so evolution costs about `sample × 2` runs. Tune `evolve.sample` and `evolve.every`.
