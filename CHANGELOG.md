# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/deepskpathak/orchestra/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/deepskpathak/orchestra/releases/tag/v0.2.0
