# Dashboards

Orchestra gives you four ways to follow a run. All of them read the same source of truth, `run.json` and `events.jsonl` under `.orchestra/runs/<runId>/`, so they always agree.

| View | Command | Best for |
|------|---------|----------|
| Full-screen terminal | `orchestra watch [runId]` | Watching a live run |
| One-shot board | `orchestra status [runId]` | Snapshots, scripts, chat |
| Web dashboard | `orchestra serve [--port N]` or `orchestra run --serve` | Diffs, logs, past runs |
| Claude Code statusline | `orchestra statusline` | Always-visible summary |

Every command except `statusline` must be run inside a repo that has been set up with `orchestra init`. `runId` is optional and defaults to the current run.

## Watch

```
orchestra watch [runId]
```

Opens a full-screen live dashboard in the terminal's alternate screen, redrawing about every 150 ms. Press `q` to quit (Ctrl-C also works). Your previous terminal contents are restored on exit.

## Status

```
orchestra status [runId]
```

Prints the same board once and exits: agents, tasks, verdicts, recent events and cost. With no runs it prints an idle line with the harness version. Colour is on when stdout is a TTY. Pass `--plain` to disable colour or `--color` to force it.

## Web dashboard

```
orchestra serve [--port N]
orchestra run "<goal>" --serve
```

`serve` starts the dashboard until you press Ctrl-C and prints its URL. The default port is **4317**. If it is taken, Orchestra tries the next free port, up to 4326, and fails with `No free port` if none is available. `--port` must be an integer from 1 to 65535.

`run --serve` starts the same server for the lifetime of that run and prints `web dashboard: <url>` before work begins. It cannot be combined with `--detach` (the detached child is started without `--serve`), so for a background run use `orchestra serve` separately.

The page lists runs (newest first) and streams live updates for the selected run. It has four parts:

- **Run summary.** Goal, status, elapsed time, cost, a progress ring (solid arc is merged tasks, faint arc is work in flight), the PLAN, BUILD, VERIFY, MERGE, LEARN stepper, and a bar showing how many tasks are in each state.
- **Task board.** One card per task with its status, a build, verify, merge track, the active agent and its last action, judge score, attempt count, time and cost. Arrows connect each task to the tasks it depends on: solid green when the dependency is merged, animated blue while it is in progress, dashed grey while it waits, dotted red when it failed. Hover or focus a card to highlight its whole dependency chain.
  - **Board** view groups cards into Queued, Building, Verifying, Merging, Done and Failed columns. Cards animate between columns as they move.
  - **Flow** view groups cards by dependency depth, so arrows read left to right.
- **Live agents and activity.** One lane per running agent session, and the event feed (tick "tool calls" to include every tool action).
- **Task drawer.** Click a card (or press Enter on it) for the description, acceptance criteria with per-criterion results, the judge verdict against the pass threshold, repair notes, the branch diff and the tail of each agent log. Links to upstream and downstream tasks open them in place. Esc closes it.

The page follows your system light or dark theme; the half-moon button overrides it. The theme and the Board or Flow choice are remembered in the browser.

## Background runs

```
orchestra run "<goal>" --detach
orchestra watch
```

`--detach` starts the run in a background process, prints its pid and writes output to `.orchestra/daemon.log`. Follow it with `watch`, `status` or `serve`.

## Claude Code statusline

`orchestra statusline` prints one short coloured summary (at most two lines, from `renderStatusLine` in `src/tui/render.ts`). Claude Code pipes a JSON object on stdin; Orchestra reads `workspace.current_dir` (or `cwd`) from it to find the repo, and falls back to the process directory if the JSON is missing or invalid. In a repo without Orchestra it prints `orchestra off`.

Plugins cannot ship a statusline, so add it to your own Claude Code settings. Use the absolute path to your checkout or install:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/orchestra/bin/orchestra statusline",
    "refreshInterval": 2
  }
}
```

`/orchestra:setup` offers to do this for you, and never overwrites an existing `statusLine`. Inside Claude Code, `/orchestra:status` and `/orchestra:serve` wrap `status` and `serve`.

## Security notes

These describe what `src/web/server.ts` does today.

- **Loopback only.** The server listens on `127.0.0.1` (the default `host` in `serve()`). It is not reachable from other machines. The CLI does not expose a host option.
- **Host header check.** Requests whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (port ignored) get `403 forbidden host`. This blocks DNS rebinding from web pages.
- **Read-only.** Any method other than `GET` gets `405 read-only`. The routes are `/` (the page), `/api/info` (harness version, current run, `maxAttempts`, `passThreshold`), `/api/runs`, `/api/runs/<runId>/stream` (server-sent events) and `/api/runs/<runId>/tasks/<taskId>`. None of them write to disk or run commands. Run and task ids are validated against a strict pattern.
- **No dependencies or outbound calls.** It uses only `node:http`, and the page loads no external scripts, styles or fonts (a test enforces this).
- **No authentication.** Anyone with local access to the machine can read the dashboard, including diffs and agent log tails. Do not forward the port to a shared network.
