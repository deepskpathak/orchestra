// Pure argv builder for the opt-in docker backend (W5.4). No IO: tests inject everything.
//
// Limit worth knowing: --network=none also blocks the model API, so a container started this way
// cannot reach it unless the image brings its own route (a local proxy or a custom network the user
// sets up). Orchestra does not guess one; see docs/isolation.md.

import { join } from 'node:path';

export const DEFAULT_IMAGE = 'orchestra-worker:latest';

export interface DockerInput {
  worktree: string;
  tmpDir: string;
  image: string;
  envNames: string[]; // names only; docker reads the values from the spawn env, never from argv
  gitCommonDir: string;
  gvisor?: boolean;
}

// Paths are mounted at the same location inside the container so the worktree's `.git` pointer
// file still resolves. The common git dir is needed for git to work at all; hooks and config
// inside it are overlaid read-only.
export function dockerArgs(i: DockerInput): string[] {
  const args = ['docker', 'run', '--rm', '--network=none'];
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
