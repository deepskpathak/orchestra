---
name: run
description: Run the Orchestra software factory on a goal. Plans a task graph, builds tasks in parallel git worktrees, verifies each with tests and a judge against hidden scenarios, repairs rejects, merges, then learns and evolves.
argument-hint: "<goal>"
disable-model-invocation: true
allowed-tools: Bash(orchestra *) Bash(git log *) Bash(git diff *)
---

Run Orchestra on this goal: $ARGUMENTS

Steps:

1. If `.orchestra/config.json` does not exist in the repo root, run `orchestra init` and show the user the detected test command. If none was detected, ask the user for one and set `testCommand` in `.orchestra/config.json` before continuing; the factory self-verifies far better with a real test command.
2. Start the run with the Bash tool using `run_in_background: true`:
   `orchestra run "<the goal, quoted>" --serve`
   Add `--sandbox auto` to confine workers with an OS sandbox, and `--unattended` for runs nobody watches (it refuses to start without a sandbox backend and strips credentials from agent env). Both are off by default; only add them when the user asks for isolation or unattended mode.
   Output is one progress line per event when not attached to a terminal. The first line is the web dashboard URL.
3. Tell the user, in one line, the web dashboard URL from the first output line (it lives until the run ends; `/orchestra:serve` reopens it later), that `orchestra watch` gives the terminal view, and the statusline shows progress if they ran `/orchestra:setup`.
4. When the background command finishes, run `orchestra status --plain` and show the board inside a code block. Then summarise in plain language: tasks merged, repairs, failures, satisfaction, cost, and whether the harness evolved.
   If the board shows tasks `awaiting_approval` (opt-in risk tiers), tell the user they need a human other than the requester to run `orchestra approve <runId> <taskId> --by <name>`. Never approve on the user's behalf and never pass an agent name. Once the last held task is approved, `orchestra approve` prints `orchestra resume <runId>` when work was deferred; offer to run it (it runs the blocked tasks, mutation and learning on the same run).
5. Give the review and land commands printed by the run (`git log ...`, `git merge orchestra/<run>/integration`). Do not merge for the user unless they ask.

If the run fails with an authentication error, tell the user to run `claude` in a terminal and `/login`, then retry. Never edit `.orchestra/harness`, `.orchestra/evals`, or `.orchestra/holdout` yourself.
