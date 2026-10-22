---
name: serve
description: Start the read-only Orchestra web dashboard on localhost for the current or past runs (agents, tasks, verdicts, diffs, events, cost).
argument-hint: "[--port N | --tui [runId]]"
allowed-tools: Bash(orchestra *)
---

Start the dashboard: run `orchestra serve $ARGUMENTS` with the Bash tool using `run_in_background: true`.

Then read the first output line of that background command for the URL (default `http://localhost:4317`, the next free port up to 4326 if taken) and give it to the user in one line. Mention that it binds to 127.0.0.1 only, is read-only, follows new runs automatically, and stops when the background task is stopped.

If the environment has no browser (locked-down VDI, SSH, terminal only), use the terminal dashboard instead: `orchestra serve --tui` (or `orchestra tui`). It is interactive and needs a real TTY, so do not run it with the Bash tool; tell the user to run it in their own terminal. It opens no port.

If the command exits with `No free port`, ask the user for a port and retry with `--port`.
