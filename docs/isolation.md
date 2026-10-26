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

## Limit you must decide on: the model API

The default `--network=none` blocks **all** networking, including the model API (`api.anthropic.com`), which a `claude` worker needs. Orchestra does not guess a route, so with the default a worker cannot call the model and will fail. The pre-flight logs a warning to that effect on every docker run. Two ways out:

- Provide the route inside the image, for example a local proxy reachable over a mounted unix socket.
- Pass `--sandbox-network <net>` with a docker network you control, ideally one whose only egress is a proxy to the model API.

`none` stays the default because any other network drops docker's network confinement, and the host allow-list (`sandbox.allowedHosts`) is not enforced by docker at all. With a non-`none` network the pre-flight skips the network probe (it would be open by design) and warns. Package registries are blocked under `none` too, so install dependencies into the image beforehand. `--network=host` is accepted but removes the isolation; do not use it for untrusted repos.

## Pre-flight self-test

With `--sandbox` or `--unattended`, the conductor checks the sandbox once per run, before the first agent call. Inside the same wrapper workers get, it tries to reach a host that is not on the allow-list (`node -e fetch`, short timeout) and to read a canary file placed in a deny-read directory. Both must fail. Before the sandboxed network probe, the same fetch runs unsandboxed as a positive control (one extra outbound request to the probe host, made by the orchestrator process, not the worker). If the control also fails there is no connectivity from this host, so a blocked result would prove nothing: the sandboxed network probe is skipped and a warning says the network block is not verified. The run continues. If either probe succeeds, the wrapper cannot start, or the output is inconclusive, the run aborts with an error naming the probe and exits 1. The network probe is a deliberate outbound attempt that is expected to be blocked. With the sandbox off nothing runs. With `--sandbox docker` the canary is written to a host directory that no container mount covers (`/var/tmp`, else the home directory), because the temp directory is mounted read-write and docker has no deny-read list. Read isolation there means "not mounted", so the probe passes only if the container cannot see the file. If no such directory is writable the read probe is skipped with a logged warning. The network probe is blocked by `--network=none`.

For `srt` and `docker` the probe command also carries worker-like trailing arguments after the node script (`--settings` with a JSON value containing quotes, spaces and `$`, plus `-p`). The probe script checks that they arrive byte for byte, and a dropped or altered argument fails pre-flight with an argv pass-through error, which catches the class of bug fixed in #74. The `claude` backend probe goes through a Bash tool call and does not check argv.

## Boundary model

The container (or the `srt`/`claude` OS sandbox) is the real control. The guard hook in `src/guard.ts` is a
deny-list backstop only.

## Tests

CI has no docker. The tests use a pure `dockerArgs` builder, an injected detector, and a spawn shim, so they pass without it.
The backend has not been run against a real docker daemon in this repo's tests.

## Verification commands are not sandboxed

Oracle tests and probes (`verification.oracles`), agentic scenario `check` commands (`verification.agenticJudge`) and mutation runs (`verification.mutation`) execute worker-written code as plain child processes of the orchestrator. They are not routed through the worker sandbox wrapper: the oracle files live outside the worktree the wrapper mounts, and the docker image is only guaranteed to hold the `claude` CLI. What they do get is a scrubbed environment: the push and publish credentials `--sandbox` strips from workers, plus `ANTHROPIC_*` and `CLAUDE_*`. PATH, HOME and other variables are kept. Filesystem and network access are not confined for these commands, so treat them like the test command and only enable them on repos you would run tests for.
