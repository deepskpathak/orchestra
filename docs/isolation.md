# Isolation: the docker backend

`orchestra run --sandbox docker` is an **opt-in** backend for untrusted repos. Each worker call runs as
`docker run --rm --network=none --user <uid>:<gid> ...` instead of a bare `claude` process. The default (`--sandbox off`) is unchanged.

## What the container gets

- The worker's worktree, read-write, mounted at the same path as on the host (so the worktree's `.git` pointer resolves).
- The temp directory, read-write.
- The shared git directory, with `hooks` and `config` overlaid **read-only**. Git needs the common dir to commit.
- Working directory set to the worktree.
- The invoking user's `uid:gid` (`--user`, where the platform has them), so files written to the worktree are not root-owned. `HOME` is set to the temp mount because an arbitrary uid usually has no writable home in the image.
- Environment by name only (`-e NAME`, values come from the spawn env): `ANTHROPIC_*` and `CLAUDE_*`. Git-hosting, registry and cloud credentials are scrubbed first, and the host `PATH` and `HOME` are not passed.
- Nothing else from the host: no `~/.ssh`, no `.env*` outside the worktree, no holdout.

## Flags

| Flag | Meaning |
|---|---|
| `--sandbox docker` | Use the container backend. Exits 1 with a hint if `docker` is not on PATH. Never chosen by `--sandbox auto`. |
| `--sandbox-image <image>` | Image to run. Default `orchestra-worker:latest`. It must contain the `claude` CLI; Orchestra does not build it. |
| `--sandbox-network <net>` | Docker network for workers. Default `none`. Any docker network name or mode (for example a user-defined network whose only route is an egress proxy to the model API). |
| `--gvisor` | Adds `--runtime=runsc` (gVisor must be installed and registered with docker). |

An image that has run the docker pre-flight (2026-11-28, colima on macOS). Pin the Claude Code version to the one you run on the host:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.332 && npm cache clean --force
```

Build it with `docker build -t orchestra-worker:latest .`. On macOS the docker daemon runs in a VM (colima or Docker Desktop), and only the host paths that VM shares can be mounted. colima shares only `$HOME` by default. A repo outside the shared paths (for example under `/tmp`) mounts as an empty directory, and the worker finds nothing to edit. Pre-flight checks for this: it writes a marker into the worktree and fails if the container cannot read it back. Keep the repo under `$HOME`, or add its path to `mounts` in `~/.colima/default/colima.yaml`. Credentials reach the container only as `ANTHROPIC_*` and `CLAUDE_*` environment variables, so a login kept in the macOS keychain is not visible there. Export `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, before the run.

## Limit you must decide on: the model API

The default `--network=none` blocks **all** networking, including the model API (`api.anthropic.com`), which a `claude` worker needs. Orchestra does not guess a route, so with the default a worker cannot call the model and will fail. The pre-flight logs a warning to that effect on every docker run. Two ways out:

- Provide the route inside the image, for example a local proxy reachable over a mounted unix socket.
- Pass `--sandbox-network <net>` with a docker network you control, ideally one whose only egress is a proxy to the model API.

`none` stays the default because any other network drops docker's network confinement, and the host allow-list (`sandbox.allowedHosts`) is not enforced by docker at all. With a non-`none` network the pre-flight skips the network probe (it would be open by design) and warns. Package registries are blocked under `none` too, so install dependencies into the image beforehand. `--network=host` is accepted but removes the isolation; do not use it for untrusted repos.

## Pre-flight self-test

With `--sandbox` or `--unattended`, the conductor checks the sandbox once per run, before the first agent call. Inside the same wrapper workers get, it tries to reach a host that is not on the allow-list (`node -e fetch`, short timeout) and to read a canary file placed in a deny-read directory. Both must fail. Before the sandboxed network probe, the same fetch runs unsandboxed as a positive control (one extra outbound request to the probe host, made by the orchestrator process, not the worker). If the control also fails there is no connectivity from this host, so a blocked result would prove nothing: the sandboxed network probe is skipped and a warning says the network block is not verified. The run continues. If either probe succeeds, the wrapper cannot start, or the output is inconclusive, the run aborts with an error naming the probe and exits 1. The network probe is a deliberate outbound attempt that is expected to be blocked. With the sandbox off nothing runs. With `--sandbox docker` the canary is written to a host directory that no container mount covers (`/var/tmp`, else the home directory), because the temp directory is mounted read-write and docker has no deny-read list. Read isolation there means "not mounted", so the probe passes only if the container cannot see the file. If no such directory is writable the read probe is skipped with a logged warning. The network probe is blocked by `--network=none`.

Probes are built through the worker code path in `src/agent.ts`, so a bug in how workers assemble their own argv shows up in pre-flight too. For `srt` and `docker` the probe goes through `wrapCommand`, the same wrapping `buildCommand` applies to a worker, and its inner command is `node -e <script> orchestra-probe <worker args>`. The worker args are what `buildArgs` gives a worker on that sandbox: `-p` with a prompt that contains double quotes, spaces and `$`, the inline guard `--settings` JSON, `--append-system-prompt` and the rest. There is no `--` in the probe's own arguments, so as with a real worker (`claude ... --settings <json>`) the only option terminator in the argv is the one the wrapper adds; the `orchestra-probe` positional is what stops node from parsing the trailing flags as its own. The probe script checks that the arguments arrive byte for byte. A dropped or altered argument fails pre-flight with an argv pass-through error naming the wrapper (for docker, the wrapper or the image entrypoint). A srt wrapper that lost its `--` (the bug fixed in #74) makes srt read the trailing `--settings` as its settings path, so it fails to start and pre-flight fails. If both probes are skipped (docker on a non-`none` network, or with no connectivity, and no writable unmounted canary directory) a warning says argv pass-through was not verified.

For `claude` the probe is a worker-shaped session from `buildCommand` (`stream-json` output, the guard hook, `--max-budget-usd 0.5`, `--max-turns 4`, the run's worker model), so the sandbox block under test is the one inline in the worker's own `--settings`, not a separate settings file. The model is asked to run `node -e <script> orchestra-probe --settings <json> -p <prompt>` with the Bash tool, and the script checks those trailing arguments the same way, which covers argv pass-through in Claude Code's Bash sandbox wrapper. A mismatch fails pre-flight and names that wrapper or the model retyping the command, because the two cannot be told apart.

Limits: the argv checks were first tested against fakes (including one that parses argv the way srt's CLI does and one that runs the claude probe's Bash command through bash). They have since passed against the real Claude Code sandbox (2026-11-25) and against real srt 0.0.83 and docker 29 on macOS (2026-11-28). The claude probe costs two short model sessions per sandboxed run.

## Boundary model

The container (or the `srt`/`claude` OS sandbox) is the real control. The guard hook in `src/guard.ts` is a
deny-list backstop only.

## Tests

CI has no docker. The tests use a pure `dockerArgs` builder, an injected detector, and a spawn shim, so they pass without it.
The backend has not been run against a real docker daemon in this repo's tests.

## Verification commands are not sandboxed

Oracle tests and probes (`verification.oracles`), agentic scenario `check` commands (`verification.agenticJudge`) and mutation runs (`verification.mutation`) execute worker-written code as plain child processes of the orchestrator. They are not routed through the worker sandbox wrapper: the oracle files live outside the worktree the wrapper mounts, and the docker image is only guaranteed to hold the `claude` CLI. What they do get is a scrubbed environment: the push and publish credentials `--sandbox` strips from workers, plus `ANTHROPIC_*` and `CLAUDE_*`. PATH, HOME and other variables are kept. Filesystem and network access are not confined for these commands, so treat them like the test command and only enable them on repos you would run tests for.
