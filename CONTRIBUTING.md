# Contributing to Orchestra

Thanks for your interest in Orchestra. This guide covers local setup, tests, and what we expect in a pull request.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Orchestra is a zero-dependency TypeScript CLI that runs on Node's native type stripping. There is **no build step** and no `npm install` is needed for the code itself.

- **Node >= 23.6** (required for running `.ts` files directly).
- **git** (the conductor uses worktrees).
- The `claude` CLI is only needed for real runs. Tests do not need it.

```sh
git clone <your fork>
cd orchestra
node --version        # must be >= 23.6
npm test              # runs the full suite
npm run demo          # end-to-end run with the simulated runner
```

There is currently no `tsconfig.json` and no type-check command, so there is no strict `tsc` step. If one is added, run it before opening a PR.

## Running tests

```sh
npm test                         # node --test test/*.test.ts
node --test test/units.test.ts   # a single file
```

Test conventions:

- Use **`node:test`** and **`node:assert`** only. No test frameworks or other dependencies.
- Group `node:` imports together at the top of the file, before local imports. Reuse helpers already imported (`readFileSync`, `join`) instead of adding duplicates.
- **Never call a real model in tests.** Use the simulator (fake runner, `src/fake.ts`) and the helpers in `test/helpers.ts`. Tests must be deterministic, offline, and free.
- Tests that create temp directories must remove them (use `try/finally` or `after`).
- For subprocess CLI tests, assert the exit code and that stderr is empty on success.
- New logic needs tests. Bug fixes should include a regression test.

## Code style

- Match the surrounding code: naming, comment density, idioms.
- Keep the project dependency-free. Adding a dependency needs a strong justification in the PR.
- Comment the why, not the what. Handle errors explicitly; no silent catches.
- Do not reformat unrelated lines.
- Do not hardcode the version string. Read it from `package.json`.
- When adding a CLI flag or command, update the `--help` output and keep its alignment. Unknown commands must still fail with the existing `unknown command` error and exit code 1.

## Changes to `harness/v1` prompts

`harness/v1` holds the role prompts (`planner.md`, `worker.md`, `judge.md`, `librarian.md`, `evolver.md`) and `config.json`. Orchestra's self-improvement loop promotes harness changes only on measured gain, and human changes are held to the same bar.

**Any PR that modifies `harness/v1` must include eval evidence**: the Factory Eval output comparing the candidate against the current harness (scores, and confirmation of no regressions). Paste it in the PR description. Prompt edits justified only by intuition will be asked for evidence before review.

## Branching

One meaningful iteration per branch. An iteration is a distinct feature, fix, research-backed improvement, or release step.

- Branch from `main` and name it `iter/<short-topic>`, for example `iter/web-dashboard`.
- Never commit directly to `main`. Open a pull request from the iteration branch. CI (`test`) must pass.
- Keep unrelated iterations on separate branches so each can be reviewed, reverted, or released alone.
- Orchestra's own `orchestra/<run>/integration` branches are run-level and local. Land them into an iteration branch, not into `main`.

## Commits and pull requests

- Keep PRs small and focused on one change. Separate refactors from features.
- Write clear commit messages: a short imperative subject (`fix: ...`, `feat: ...`, `docs: ...`, `test: ...`), and a body explaining the why when it is not obvious.
- Fill in the pull request template: what changed, how you verified it, risks.
- `npm test` must pass. Describe any gap honestly.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- Do not include secrets, real credentials, or personal paths and emails in code, tests, or fixtures.

## Reporting bugs and requesting features

Use the issue templates. For security problems, do **not** open a public issue; follow [SECURITY.md](SECURITY.md).
