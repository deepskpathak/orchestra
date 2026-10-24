// Pure argv builder for the opt-in docker backend (W5.4). No IO: tests inject everything.
//
// Limit worth knowing: the default --network=none also blocks the model API, so a claude worker in
// such a container cannot reach it unless the image brings its own route (a local proxy) or the user
// picks a network with --sandbox-network that has one. Orchestra does not guess a route; the
// pre-flight warns when the network is none. See docs/isolation.md.

import { join } from 'node:path';

export const DEFAULT_IMAGE = 'orchestra-worker:latest';

export interface DockerInput {
  worktree: string;
  tmpDir: string;
  image: string;
  envNames: string[]; // names only; docker reads the values from the spawn env, never from argv
  gitCommonDir: string;
  gvisor?: boolean;
  network?: string; // docker --network value; default 'none'
  user?: string; // "uid:gid" so files written to the mounts are owned by the invoking user, not root
}

export const DEFAULT_NETWORK = 'none';

// A docker network name or mode. Kept strict: it is spliced into a --network= argument.
export function validNetwork(n: string): boolean {
  return /^[A-Za-z0-9][\w.:-]*$/.test(n);
}

// uid:gid of the orchestrator process (POSIX only); undefined where the platform has none.
export function hostUser(): string | undefined {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}

// Paths are mounted at the same location inside the container so the worktree's `.git` pointer
// file still resolves. The common git dir is needed for git to work at all; hooks and config
// inside it are overlaid read-only.
export function dockerArgs(i: DockerInput): string[] {
  const args = ['docker', 'run', '--rm', `--network=${i.network ?? DEFAULT_NETWORK}`];
  // A non-root uid has no writable HOME in most images, and claude writes under it; use the temp mount.
  if (i.user) args.push('--user', i.user, '-e', `HOME=${i.tmpDir}`);
  if (i.gvisor) args.push('--runtime=runsc');
  args.push('-v', `${i.worktree}:${i.worktree}:rw`, '-v', `${i.tmpDir}:${i.tmpDir}:rw`);
  args.push('-v', `${i.gitCommonDir}:${i.gitCommonDir}:rw`);
  args.push('-v', `${join(i.gitCommonDir, 'hooks')}:${join(i.gitCommonDir, 'hooks')}:ro`);
  args.push('-v', `${join(i.gitCommonDir, 'config')}:${join(i.gitCommonDir, 'config')}:ro`);
  args.push('-w', i.worktree);
  for (const n of i.envNames) args.push('-e', n);
  args.push(i.image);
  return args;
}

// Only model credentials and Claude settings cross into the container. The host PATH, HOME and
// every push or publish token stay out (scrubWorkerEnv already removed those from the input).
export function containerEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => env[k] !== undefined && /^(ANTHROPIC_|CLAUDE_)/.test(k));
}
