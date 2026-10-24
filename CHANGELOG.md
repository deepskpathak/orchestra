# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Research paper `docs/research/closing-the-gaps.md`: a review of about 90 academic, industry and practitioner sources on evaluating, verifying, isolating and self-improving agentic software factories, and an ordered plan (8 workstreams, 6 milestones, stated hypotheses) to address the whitepaper's limitations. It also documents a gap: a candidate harness's own evolvable judge scores its Factory Eval runs.

## [0.6.1] - 2026-10-22

### Added

- Whitepaper (`docs/whitepaper-orchestra.md`) and Substack-style blog post (`docs/blog/orchestra-substack-post.md`), linked from the README and the architecture doc.

## [0.6.0] - 2026-10-22

### Added

- Wider evolvable harness surface (#9). Three small optional files, `tools.md` (worker and judge), `style.md` (worker) and `checklist.md` (judge), can now be tuned by the evolver without rewriting a role prompt. Missing files are treated as empty, and a variant may not remove lines from `checklist.md`. Skills and executable scripts remain out of scope.
- Multi-candidate evolution (#8). The opt-in `evolve.candidates` setting (default `1`, behaviour unchanged) makes the evolver propose k variants per cycle, screen each on `min(2, sample)` eval cases and drop any that regress a case the incumbent passes, compose the survivors into one variant, and decide with the usual `promotionDecision` rules. Archive entries gain optional `parents` and `screenScore`, and screened-out candidates appear under PREVIOUSLY REJECTED VARIANTS.
- The seed evolver prompt documents the `{ variants: [...] }` output, the different-weaknesses rule and `COMPOSE VARIANTS`.
- Contrastive repair (#11), opt-in via the `contrastive` block in `.orchestra/config.json`. On a repair attempt in a repo without a `testCommand`, two workers try the task in separate worktrees (one follows the repair notes, one takes a different approach) and one comparison judge call picks a winner. The winner's branch continues, the loser is deleted, and the judge's reasons feed the librarian as lesson evidence. The task drawer shows "Picked A over B because ...". Disabled by default; `passThreshold` is never lowered.

## [0.5.0] - 2026-10-22

### Added

- Per-domain learning libraries (#10). The planner tags each run with a short `domain` slug (existing domains plus at most one new one per run), stored on the run. Lessons live in `learnings/<domain>.json` plus `learnings/_global.json`, and the `learnings.md` mirror is grouped by domain.
- Every lesson carries `evidence` (the run or task that supports it) and a `hits` count. The librarian must cite evidence, and lessons without it are dropped.
- `orchestra learnings --domain <slug>` filters the list to one domain.

### Changed

- Prompts receive the run's domain lessons then global ones under a token budget, instead of the whole store.
- The 25-lesson cap applies per domain, and the least recently evidenced lessons are dropped first.
- `orchestra evolve` receives a per-domain summary (counts and top lessons) instead of the full store.
- An existing `learnings.json` is migrated to `_global.json` on first read.

## [0.4.0] - 2026-10-22

### Added

- `orchestra serve --tui` (alias `orchestra tui`): an interactive full-screen terminal dashboard for environments where a browser is not allowed. It needs no HTTP server or port. It shows the run board, tasks, agents and events live, follows new runs (`f` re-follows), and opens a drawer with per-task diff and logs. Keyboard driven, restores the terminal on exit and signals, and exits 1 with a hint to use `orchestra status` or `orchestra watch` when not attached to a TTY.

### Changed

- Dashboard data access moved from the web server into a shared `src/dashboard-data.ts`, used by both the web dashboard and the TUI.

## [0.3.0] - 2026-10-22

### Added

- `orchestra --version` (and `-v`) prints the installed version.
- Web dashboard redesign: a Trello-style task board with SVG dependency arrows (coloured by whether the dependency is merged, in progress, waiting or failed), a Flow view that groups tasks by dependency depth, a run progress ring, pipeline stepper and status mix bar, per-card stage tracks, live agent lanes, and a slide-in task drawer with per-criterion results, the judge score against the pass line, diff and logs. Still a single dependency-free page.
- `/api/info` also returns the current harness `maxAttempts` and `passThreshold`.

### Fixed

- `orchestra evolve` no longer scores an eval run that died of infrastructure (usage limit, auth, network) as 0 and rejects the candidate; the result is inconclusive and the candidate stays available.
- `evolve` raises `evolve.sample` to `evolve.minCases`, and exits before running any eval when there are too few cases, instead of spending runs and then refusing to promote.

## [0.2.0] - 2026-10-22

### Added

- Community and project health files: contributing guide, code of conduct, security policy, issue and pull request templates.
- GitHub Actions CI (`npm test` on Node 24) and a branching section in the contributing guide (one `iter/<topic>` branch per iteration, changes land by pull request).
- Token and cache usage per agent session in the ledger, and cache hit ratio in `orchestra stats`.
- Tiered judging (`judgeTiers` in `.orchestra/config.json`): a cheap judge model first, escalating to the strong judge on test failure, borderline scores or open issues. Off by default.
- Research notes and a ranked improvement backlog in `docs/research/cost-accuracy-speed.md`.
- Per-criterion judging: verdicts may carry an optional `criteria` list (pass, score and note per acceptance criterion), the score is aggregated from it, and repair notes list the failing criteria.
- Planner fast path (`fastPath` in `.orchestra/config.json`): a small single-concern goal gets exactly one task and no hidden-scenario requirement. Off by default.
- Model tiers (`strong`, `balanced`, `fast`) in harness `models`, resolved through the capability table in `src/models.ts` using the optional `provider` key. Literal model names are still accepted unchanged.
- Progress file for repair attempts at `.orchestra/runs/<run>/progress/<task>.json`, holding the previous diff summary and judge issues. The repair prompt points at it instead of inlining long text.
- Deterministic pre-judge checks (`preJudge` in `.orchestra/config.json`): an optional lint command and a check that new exports under `src/` come with a changed test file. Failures go straight to repair without a judge call. Off by default.

### Changed

- The judge now retries once on failure and never scores a worker 0.00 for a judge error.
- Role prompts are ordered from stable to volatile content so their prefix can be shared and cached.
- Harness promotion requires a minimum number of eval cases (`evolve.minCases`, default 5) and a gain above the observed spread. `evolve.sample` defaults to 5.

## [0.1.0]

First release.

### Added

- **Software factory**: a zero-dependency TypeScript CLI (Node 23.6+, native type stripping) and Claude Code plugin. The conductor runs planner, then parallel workers in isolated git worktrees, then tests and a judge against hidden holdout scenarios, a repair loop, a serialized merge queue with post-merge tests, and a librarian that records learnings.
- **Self-improvement**: versioned harness (`harness/v1`), an evolver that proposes variants, Factory Eval harvested from successful runs that scores a candidate against the incumbent, promotion only on measured gain with no regressions, and a full archive with rollback.
- **Terminal visuals**: live dashboard (`orchestra watch`, and `orchestra run` on a TTY), one-shot status, stats with trends, and a Claude Code statusline.
- **Safety**: isolated agent settings, a `PreToolUse` guard (holdout, network, secrets, harness edits), read-only judges, and per-role and per-run budgets.
- **Claude Code plugin**: `/orchestra:run`, `status`, `stats`, `evolve`, `setup`, and a local marketplace.
- **Simulated runner** for tests and `orchestra demo`.
- **Read-only web dashboard**: `orchestra serve` and `orchestra run --serve`. A dependency-free `node:http` server on `127.0.0.1` streams `run.json` and `events.jsonl` over SSE to a single-file HTML page, with task detail (verdict, diff, agent log tails) and an `/orchestra:serve` skill.

[Unreleased]: https://github.com/deepskpathak/orchestra/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/deepskpathak/orchestra/releases/tag/v0.3.0
[0.2.0]: https://github.com/deepskpathak/orchestra/releases/tag/v0.2.0
