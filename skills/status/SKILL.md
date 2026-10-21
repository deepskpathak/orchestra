---
name: status
description: Show the Orchestra board for the current or a given run (agents, tasks, verdicts, events, cost).
argument-hint: "[runId]"
allowed-tools: Bash(orchestra *)
---

Run `orchestra status --plain $ARGUMENTS` and show the output verbatim inside a code block. Then add at most three short bullets: what is running now, anything in repair or failed and why, and the next action. For a live view, remind the user they can run `orchestra watch` in a terminal.
