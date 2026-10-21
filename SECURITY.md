# Security Policy

## Supported versions

Orchestra is pre-1.0. Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: on the repository, go to **Security > Advisories > Report a vulnerability**. Include:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The affected version or commit and your Node version

We aim to acknowledge reports within a few days and to agree on a fix and disclosure timeline with you. Please give us reasonable time to release a fix before public disclosure.

## Scope and security model

Orchestra runs coding agents (via the Claude Code CLI) against your repository, so its safety properties matter. What it does and does not promise:

**In scope**

- **The guard hook** (`src/guard.ts`): a `PreToolUse` hook injected into every agent session. It blocks access to holdout scenarios, edits to the harness, evals and archive, network and publishing commands (`curl`, `wget`, `ssh`, `git push`, `npm publish`, and similar), and secret-like files (`.env*`, keys, `.npmrc`). It fails closed on unreadable hook input. Bypasses of the guard are in scope.
- **Isolation of agents**: agents run with isolated settings, in per-task git worktrees, with read-only judges and per-role and per-run budgets. Ways for an agent to escape its worktree, read holdout data, or modify the harness are in scope.
- **The web dashboard** (`orchestra serve`): read-only and bound to `127.0.0.1` by default. Any write path, or exposure beyond loopback without an explicit opt-in, is in scope.

**Out of scope / known limits**

- The guard is a pattern-based safety net, not a sandbox. It inspects tool inputs with regular expressions and cannot stop every indirect way to reach the network or read files (for example, through an interpreter running arbitrary code). Run Orchestra in a container, VM, or otherwise restricted environment for untrusted repositories or tasks.
- Agents execute code in your repository, including your tests. Treat the repository as trusted input.
- Vulnerabilities in Claude Code, Node.js, git, or the model itself should be reported to their maintainers.
- Binding the dashboard to a non-loopback host is an explicit user choice and is your responsibility to protect.

## Handling secrets

Orchestra never needs credentials in its configuration. Do not commit secrets to a repository you run it on, and do not paste them into task descriptions, since those are passed to agents and written to run logs under `.orchestra/`.
