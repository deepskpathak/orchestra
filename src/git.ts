// Git plumbing. Each run gets an integration branch in its own worktree; each task gets a
// branch + worktree cut from the integration tip. Nothing touches the user's checkout,
// so a run is fully reversible: delete the orchestra/<run>/* branches.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function assertRepo(root: string): void {
  if (!tryGit(root, 'rev-parse', '--git-dir').ok) throw new Error(`${root} is not a git repository`);
  if (!tryGit(root, 'rev-parse', '--verify', 'HEAD').ok) throw new Error('Repository has no commits yet; make an initial commit first');
}

// Keep .orchestra out of git without editing the user's tracked .gitignore.
export function excludeOrchestra(root: string): void {
  const abs = resolve(root, git(root, 'rev-parse', '--git-common-dir'), 'info', 'exclude');
  mkdirSync(dirname(abs), { recursive: true });
  const cur = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  if (!cur.split('\n').includes('.orchestra/')) appendFileSync(abs, `${cur.endsWith('\n') || !cur ? '' : '\n'}.orchestra/\n`);
}

export interface Worktree {
  path: string;
  branch: string;
}

export function createIntegration(root: string, wtRoot: string, runId: string, baseRef?: string): Worktree & { base: string } {
  const base = git(root, 'rev-parse', baseRef ?? 'HEAD');
  const branch = `orchestra/${runId}/integration`;
  const path = join(wtRoot, runId, '_integration');
  mkdirSync(join(wtRoot, runId), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', branch, path, base);
  return { path, branch, base };
}

export function createTaskWorktree(root: string, wtRoot: string, runId: string, taskId: string, from: string): Worktree {
  const branch = `orchestra/${runId}/${taskId}`;
  const path = join(wtRoot, runId, taskId);
  if (existsSync(path)) return { path, branch };
  git(root, 'worktree', 'add', '-q', '-b', branch, path, from);
  return { path, branch };
}

// Workers are asked to commit; commit anything they left behind so the judge sees it all.
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, 'add', '-A');
  if (tryGit(cwd, 'diff', '--cached', '--quiet').ok) return false;
  git(cwd, '-c', 'user.name=Orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '-qm', message);
  return true;
}

export function diffSince(cwd: string, base: string, maxChars = 60_000): string {
  const d = tryGit(cwd, 'diff', `${base}...HEAD`).out;
  return d.length > maxChars ? d.slice(0, maxChars) + `\n... [diff truncated, ${d.length} chars total]` : d;
}

// Throws on a bad base; callers that must not fail wrap it.
export function diffStat(cwd: string, base: string, maxChars = 4000): string {
  const d = git(cwd, 'diff', '--stat', base);
  return d.length > maxChars ? d.slice(0, maxChars) + '\n... [stat truncated]' : d;
}

export function changedFiles(cwd: string, base: string): string[] {
  return git(cwd, 'diff', '--name-only', base).split('\n').filter(Boolean);
}

export function hasChangesSince(cwd: string, base: string): boolean {
  return tryGit(cwd, 'rev-list', '--count', `${base}..HEAD`).out !== '0';
}

export function mergeBase(cwd: string, a: string, b: string): string {
  return git(cwd, 'merge-base', a, b);
}

export function merge(integrationPath: string, branch: string, message: string): { ok: boolean; detail: string } {
  const r = tryGit(integrationPath, '-c', 'user.name=Orchestra', '-c', 'user.email=orchestra@localhost', 'merge', '--no-ff', '-m', message, branch);
  if (r.ok) return { ok: true, detail: r.out };
  tryGit(integrationPath, 'merge', '--abort');
  return { ok: false, detail: r.out };
}

// After a merge conflict the task restarts from the latest integration tip.
export function resetTo(cwd: string, ref: string): void {
  git(cwd, 'reset', '-q', '--hard', ref);
  git(cwd, 'clean', '-qfd');
}

export function existsAtRef(cwd: string, ref: string, file: string): boolean {
  return tryGit(cwd, 'cat-file', '-e', `${ref}:${file}`).ok;
}

// Overwrite (or recreate) files in the working tree with their content at `ref`. Files absent at
// `ref` are left alone. Returns the files restored. Callers resetTo() afterwards to undo.
export function restoreFromRef(cwd: string, ref: string, files: string[]): string[] {
  const present = files.filter((f) => existsAtRef(cwd, ref, f));
  for (const f of present) git(cwd, 'checkout', ref, '--', f);
  return present;
}

export function head(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD');
}

export function removeWorktree(root: string, path: string): void {
  tryGit(root, 'worktree', 'remove', '--force', path);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  tryGit(root, 'worktree', 'prune');
}

// Force-deletes a branch (loser cleanup). A missing branch is not an error.
export function deleteBranch(root: string, branch: string): void {
  tryGit(root, 'branch', '-D', branch);
}

export function runTests(cwd: string, command: string, timeoutMs = 10 * 60_000): { ok: boolean; tail: string } {
  const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.length > 4000 ? '...' + out.slice(-4000) : out;
  if (r.error) return { ok: false, tail: `${r.error.message}\n${tail}` };
  return { ok: r.status === 0, tail };
}

export function trackedFiles(root: string, limit = 300): string[] {
  const all = git(root, 'ls-files').split('\n').filter(Boolean);
  return all.slice(0, limit);
}
