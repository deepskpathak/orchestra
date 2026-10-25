# Getting started

This guide takes you from a fresh checkout to a first Orchestra run. It covers both ways to use it (Claude Code plugin and plain CLI) and a zero-cost demo.

## Prerequisites

- **Node 23.6 or newer.** Orchestra runs TypeScript directly, so there is no build step (`engines` in `package.json`).
- **git.** Orchestra works in git worktrees and needs a git repository to operate on.
- **Claude Code CLI** with headless auth working. Real runs spawn Claude sessions. `orchestra doctor` checks this for you.

You do not need Claude auth for the demo and the simulator (see [Try it without spending tokens](#try-it-without-spending-tokens)).

## Install

### As a Claude Code plugin

The plugin adds the `/orchestra:*` slash commands and puts `orchestra` on the Bash tool's PATH.

```bash
claude plugin marketplace add <path-to-orchestra>
claude plugin install orchestra@orchestra-local
```

`<path-to-orchestra>` is the directory where you cloned this repository.

For development, load the plugin for a single session instead of installing it:

```bash
claude --plugin-dir <path-to-orchestra>
```

### As a CLI in any terminal

From the repository root:

```bash
npm link
```

This exposes the `orchestra` command globally. Without linking, call the shim directly:

```bash
<path-to-orchestra>/bin/orchestra --help
```

`bin/orchestra` is a small shell script that runs `bin/orchestra.ts` with `node`.

## Set up a project

Run these inside the git repository you want Orchestra to work on.

```bash
orchestra init
```

`init` creates `.orchestra/`, seeds the first harness version, detects your test command (for example `npm test --silent`, `mvn -q test`, `cargo test --quiet`) and adds `.orchestra` to the repo's git excludes. It prints the harness version, detected test command, concurrency and run budget.

If no test command was detected, set `testCommand` in `.orchestra/config.json`. Verification is much stronger with a real test command.

Inside Claude Code, `/orchestra:setup` does the same and also offers to wire up the statusline.

Then check your environment:

```bash
orchestra doctor
```

If headless auth fails, run `claude` in a terminal and use `/login`, then retry.

## Your first run

```bash
orchestra run "Add a --json flag to the export command"
```

Orchestra plans a task graph, builds tasks in parallel git worktrees, verifies each one with tests and a judge, repairs rejects, merges, then learns from the run.

- On a TTY you get a live dashboard. Otherwise you get one progress line per event.
- `--detach` runs in the background. Follow it with `orchestra watch`.
- `--serve` also starts the read-only web dashboard while the run is live.
- `--no-evolve` skips the automatic self-improvement check after the run.
- `--sandbox auto|srt|claude|off` (default `off`) confines workers with an OS sandbox: writes only to the worktree and temp, no reads of `~/.ssh` and other credential directories, `.env*` or the hidden scenarios, network limited to the model API plus `sandbox.allowedHosts` from `.orchestra/config.json`. `srt` wraps the worker in `srt` with a settings file generated under `.orchestra/sandbox/` (outside the worktree); `claude` passes fail-closed `sandbox` settings inline via `--settings` (nothing is written into the worktree; needs `bwrap` and `socat` on Linux, `sandbox-exec` on macOS); `auto` picks whichever is installed and warns if none is. Commit, merge and PR creation stay in the orchestrator.
- `--sandbox docker` (with optional `--sandbox-image <image>`, `--sandbox-network <net>` and `--gvisor`) runs workers in `docker run --rm --network=none` as your uid:gid by default; opt-in for untrusted repos, see [isolation.md](isolation.md) for the model API caveat.
- `--unattended` refuses to start (exit 1, before any agent call) unless a sandbox backend is available, and strips git-hosting, registry and cloud credentials from agent environments. It cannot be combined with `--sandbox off`.

In Claude Code, use `/orchestra:run <goal>` instead.

Watch from another terminal at any time:

```bash
orchestra watch      # full-screen live dashboard, q to quit
orchestra status     # one-shot board
```

### Landing the result

Your checkout is never touched. Results land on a branch named `orchestra/<run>/integration`. The run prints the exact commands when it finishes. In general:

```bash
git log main..orchestra/<run>/integration
git merge orchestra/<run>/integration
```

## Try it without spending tokens

`orchestra demo` creates a temporary git repo and runs a simulated factory in it. No Claude sessions are started and no tokens are spent.

```bash
orchestra demo
```

The same script is available as `npm run demo` from the Orchestra repository.

To run the simulator against your own repo, set `ORCHESTRA_RUNNER=fake`:

```bash
ORCHESTRA_RUNNER=fake orchestra run "Add a health endpoint"
```

`ORCHESTRA_FAKE_STEP_MS` controls the simulated step delay in milliseconds (default 150). This is useful for seeing the dashboards and the run lifecycle before you commit to a real run.

## Command reference

| Command | Purpose |
|---|---|
| `orchestra init` | Set up `.orchestra/` in the current git repo |
| `orchestra run "<goal>"` | Plan, build, verify, merge, learn |
| `orchestra watch [runId]` | Full-screen live dashboard |
| `orchestra status [runId]` | One-shot board |
| `orchestra serve [--port N]` | Read-only web dashboard (default port 4317) |
| `orchestra bench` | Benchmark suite against hidden checks (see [bench.md](bench.md)) |
| `orchestra stats` | Factory health per harness version |
| `orchestra evolve` | Propose, evaluate and maybe promote a better harness |
| `orchestra learnings [--domain <slug>]` | Show what the factory has learned in this repo (`--domain` filters to one domain, `global` for cross-domain lessons) |
| `orchestra atlas build` / `orchestra atlas stats` | Build or refresh the Repo Atlas code graph for HEAD (`.orchestra/atlas/<sha>.json`), or show its file, symbol and edge counts. Work even when `context.atlas.enabled` is false (optional ctags or graphify inputs: see `context.atlas.external` in [configuration](configuration.md)); `.orchestra/`, `.env*` and secret files are never indexed |
| `orchestra evals` | List Factory Eval cases (`--regression`, `--tag <t>`) |
| `orchestra evals add` | Add a case for a goal you choose, or harvest a failed run with `--from-run <id> --fix <commit>` |
| `orchestra evals audit` | Check cases and lessons for solution leakage (exit 1 on findings) |
| `orchestra evals ablation` | Replay the holdout with and without learnings |
| `orchestra promote <vN>` | Promote a harness version (also used for rollback) |
| `orchestra doctor` | Check Claude CLI and headless auth |
| `orchestra demo` | Simulated run in a temp repo |
| `orchestra statusline` | Statusline command for Claude Code |

Run `orchestra --help` for the same list. The version is in `package.json`.

## Troubleshooting

- **`Not inside a git repository.`** Run the command from inside a git repo.
- **`Orchestra is not initialised here.`** Run `orchestra init` first.
- **Auth errors during a run.** Run `claude`, use `/login`, and retry. Use `orchestra doctor` to confirm.
