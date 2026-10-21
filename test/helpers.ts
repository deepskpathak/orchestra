import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedHarness } from '../src/harness.ts';
import { DEFAULT_PROJECT_CONFIG, Store } from '../src/store.ts';
import type { ProjectConfig } from '../src/types.ts';

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' })) process.env[k] = v;

export function tempRepo(config: Partial<ProjectConfig> = {}): Store {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# t\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  const store = new Store(dir);
  store.writeJson('config.json', { ...DEFAULT_PROJECT_CONFIG, ...config });
  seedHarness(store);
  return store;
}
