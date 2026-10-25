# ♫ Orchestra

**A self-improving multi-agent software factory built on Claude Code.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it is

You give Orchestra a goal. It plans a task graph, builds tasks in parallel git worktrees, verifies each one with tests plus an independent judge working from hidden scenarios, repairs what fails, merges through a serialized queue, records what it learned, and periodically evolves its own prompts and config. A new harness version is promoted only when a measured eval shows a gain.

```
╭─ ♫ ORCHESTRA  r20261021-2022-77o1  harness v1 ──────────────────────────────── 00:01 ─╮
│ Goal Build a tiny CLI with config loading and docs                                     │
│ ✓ PLAN  ─  · BUILD  ─  ▶ VERIFY  ─  · MERGE  ─  · LEARN                                │
│ ███████░░░░░░░░░░░░░░░░░░░ 1/4  ✓1 ●2 ⟳0 ✗0  $1.04  RUNNING                            │
├─ Tasks ────────────────────────────────────────────────────────────────────────────────┤
│ ✓ T1   merged   ███████░ 0.89  try 1  $0.26  Core module                               │
│ ⠸ T2   running  ███░░░░░ 0.40  try 2  $0.46  Config loader                             │
│ ⠸ T3   judging  ░░░░░░░░ ----  try 1  $0.20  CLI wiring ⇠ T1                           │
╰────────────────────────────────────────────────────────────────────────────────────────╯
```

## Features

- **Planner, worker, judge, librarian, evolver.** Separate roles with fresh context per attempt. Planners never code and judges never edit.
- **Parallel git worktrees.** Each task builds in its own worktree. Your checkout is never touched.
- **Hidden holdout scenarios.** The judge checks work against scenarios the workers cannot read.
- **Opt-in M4 verification.** Judge panel, agentic judge, acceptance contracts, oracles and a mutation score, all off by default (`verification.*`, see docs/configuration.md).
- **Self-correcting.** Judge rejections, merge conflicts, and red post-merge tests all trigger a retry.
- **Merge queue.** Tasks merge one at a time onto `orchestra/<run>/integration`, with tests after each merge.
- **Self-evaluating.** Every agent session is recorded in a ledger, and `orchestra stats` reports health per harness version.
- **Self-improving.** The evolver proposes a harness change, a Factory Eval compares it to the incumbent, and promotion needs a measured gain. Rollback is `orchestra promote <vN>`.
- **Live dashboards.** A terminal dashboard, a read-only localhost web task board with dependency arrows, and a Claude Code statusline.
- **Guard rails in code.** A PreToolUse hook is a deny-list backstop for holdout reads, network commands, `git push`, and edits to the harness and evals. It is not the isolation boundary (see [Isolation](#isolation)). Each run has a budget.

## Quick start

Requirements: Node 23.6 or newer (runs TypeScript directly, no build step), git, and Claude Code with headless auth working (`orchestra doctor` checks it).

**1. Try the demo (no tokens spent).** It runs the full pipeline with a simulated runner in a temporary repo:

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

Results land on `orchestra/<run>/integration`. Review with `git log main..orchestra/<run>/integration`, then `git merge` that branch to land it.

Set `ORCHESTRA_RUNNER=fake` to use the simulator instead of real Claude sessions in any command.

## Commands

| Command | What it does |
|---|---|
| `orchestra init` | Set up .orchestra/ in the current git repo |
| `orchestra run "<goal>"` | Plan, build, verify, merge, learn (live dashboard on a TTY) |
| `    --detach` | Run in the background; follow with `orchestra watch` |
| `    --no-evolve` | Skip the automatic evolution check after the run |
| `    --serve` | Also serve the web dashboard while the run is live |
| `    --sandbox auto\|srt\|claude\|off` | OS-sandbox workers: writes only to the worktree and temp, no credential reads, network limited to the model API plus `sandbox.allowedHosts`. Default `off` |
| `    --sandbox docker` | Opt-in container backend (`docker run --rm --network=none` by default, `--sandbox-image <image>`, `--sandbox-network <net>`, `--gvisor`) for untrusted repos. See docs/isolation.md |
| `    --unattended` | Refuse to start without a sandbox backend (`srt`, `bwrap` + `socat`, or `sandbox-exec`); strips credentials from agent env |
| `orchestra serve [--port N]` | Web dashboard on localhost (default 4317), read-only |
| `orchestra serve --tui [runId]` | Interactive terminal dashboard, no browser and no port (alias: `orchestra tui`) |
| `orchestra watch [runId]` | Full-screen live dashboard (q to quit) |
| `orchestra status [runId]` | One-shot board of the current or given run |
| `orchestra bench` | Run the fixed benchmark suite (arms x goals x repeats, hidden checks); `--verify-oracles` validates the suite, `--ablations` runs the ablation arms and a matched-cost single-session baseline. See [docs/bench.md](docs/bench.md) |
| `orchestra stats` | Factory health per harness version, plus outcome metrics (merge acceptance, edits before landing, revert rate, cost per accepted merge, success by task length), merged-but-wrong rate and judge agreement split by M4 verification mode |
| `orchestra evolve` | Propose, evaluate, and maybe promote a better harness |
| `orchestra learnings [--domain <slug>]` | Show what the factory has learned in this repo (`--domain` filters to one domain, `global` for cross-domain lessons) |
| `orchestra atlas build` / `orchestra atlas stats` | Build or refresh the Repo Atlas code graph for HEAD (`.orchestra/atlas/<sha>.json`), or show its file, symbol and edge counts. Work even when `context.atlas.enabled` is false; `.orchestra/`, `.env*` and secret files are never indexed |
| `orchestra evals` | List Factory Eval cases (`--regression`, `--tag <t>`) |
| `orchestra evals add` | Add a case for a goal you choose, or harvest a failed run with `--from-run <id> --fix <commit>` |
| `orchestra evals audit` | Check cases and lessons for solution leakage (exit 1 on findings) |
| `orchestra evals ablation` | Replay the holdout with and without learnings |
| `orchestra promote <vN>` | Promote a harness version (also used for rollback) |
| `orchestra doctor` | Check Claude CLI and headless auth |
| `orchestra demo` | Simulated run in a temp repo (no tokens spent) |
| `orchestra statusline` | Statusline command for Claude Code (reads JSON on stdin) |

Inside Claude Code, the plugin adds `/orchestra:setup`, `/orchestra:run`, `/orchestra:serve`, `/orchestra:status`, `/orchestra:stats`, `/orchestra:bench`, and `/orchestra:evolve`.

## Isolation

The boundary is the OS, not the hook. Opt in with `--sandbox auto|srt|claude` (OS sandbox: `srt`, or Claude Code `sandbox` settings via `bwrap` + `socat` or `sandbox-exec`) or `--sandbox docker` (container, optional gVisor). The sandbox allows writes only to the worktree and temp, denies reads of credential directories, `.env*` and the holdout, and limits network to the model API plus `sandbox.allowedHosts`. A pre-flight self-test aborts the run if a blocked host or denied path is reachable. Credentials are stripped from worker env, `.git/hooks` and `.git/config` are read-only, and only the orchestrator commits, pushes and opens PRs. `--unattended` refuses to start without a backend. Missing tools are detected and the run degrades to unsandboxed (attended only).

The `src/guard.ts` hook stays on as **defence in depth**. It is a deny-list that `python`, `node`, git remotes or DNS can bypass. `srt` is a research preview and sandbox setup varies by OS (Linux needs unprivileged user namespaces). Details: [docs/architecture.md](docs/architecture.md#boundary-model-os-sandbox-first-guard-hook-as-backstop) and [docs/isolation.md](docs/isolation.md).

## Documentation

- [Getting started](docs/getting-started.md): install, init, first run, and the demo
- [Architecture](docs/architecture.md): roles, worktrees, holdout scenarios, merge queue, event log
- [Self-improvement](docs/self-improvement.md): ledger, Factory Eval, evolve, promote and rollback
- [Dashboards](docs/dashboards.md): watch, status, serve, and the statusline
- [Isolation](docs/isolation.md): sandbox boundary model and the docker backend
- [Configuration](docs/configuration.md): `.orchestra/config.json` and harness config
- [Whitepaper](docs/whitepaper-orchestra.md): design, methodology, limitations, and threats to validity
- [Closing the gaps](docs/research/closing-the-gaps.md): research review and the ordered plan to address the whitepaper's limitations
- [Blog post](docs/blog/orchestra-substack-post.md): a plain-language tour with an example run

## Project

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE) (MIT)

## Status

The current version is in `package.json`. The test suite runs against the simulator (`npm test`). Workers share one machine unless you opt in to `--sandbox`; the default is unsandboxed. Evolution reruns past goals, so it costs roughly `sample × 2` runs; tune `evolve.sample`, `evolve.every` and `evolve.candidates` in the config.
