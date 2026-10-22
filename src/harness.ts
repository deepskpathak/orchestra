// The harness is the evolvable part of Orchestra: role prompts plus model/threshold config.
// Each version is a directory .orchestra/harness/<vN>/. `current` points at the promoted one.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROVIDER, resolveModels } from './models.ts';
import type { Store } from './store.ts';
import type { HarnessConfig, Role } from './types.ts';

export const ROLES: Role[] = ['planner', 'worker', 'judge', 'librarian', 'evolver'];
export const EVOLVABLE_FILES = ['planner.md', 'worker.md', 'judge.md', 'librarian.md', 'config.json'];

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function packageVersion(): string {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

export interface Harness {
  version: string;
  prompts: Record<Role, string>;
  config: HarnessConfig;
}

export interface ArchiveEntry {
  version: string;
  parent: string | null;
  createdAt: number;
  rationale: string;
  evalScore: number | null;
  evalDetail?: Record<string, number>;
  parents?: string[]; // composed variants list the versions they merged
  screenScore?: number | null; // mean score on the cheap screening sample
  status: 'promoted' | 'candidate' | 'rejected' | 'retired';
}

export function seedHarness(store: Store): void {
  const dest = store.path('harness', 'v1');
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(PACKAGE_ROOT, 'harness', 'v1'), dest, { recursive: true });
  }
  if (!store.readText('harness/current').trim()) store.writeText('harness/current', 'v1\n');
  const archive = readArchive(store);
  if (!archive.some((a) => a.version === 'v1')) {
    archive.push({ version: 'v1', parent: null, createdAt: Date.now(), rationale: 'seed', evalScore: null, status: 'promoted' });
    writeArchive(store, archive);
  }
}

export function currentVersion(store: Store): string {
  return store.readText('harness/current').trim() || 'v1';
}

export function loadHarness(store: Store, version = currentVersion(store)): Harness {
  const dir = store.path('harness', version);
  if (!existsSync(dir)) throw new Error(`Harness ${version} not found at ${dir}. Run \`orchestra init\`.`);
  const prompts = {} as Record<Role, string>;
  for (const role of ROLES) prompts[role] = readFileSync(join(dir, `${role}.md`), 'utf8');
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as HarnessConfig;
  // Resolve tiers here so the conductor, ledger and dashboard only see concrete model ids.
  if (config.models) config.models = resolveModels(config.models, config.provider ?? DEFAULT_PROVIDER);
  return { version, prompts, config };
}

export function listVersions(store: Store): string[] {
  const d = store.path('harness');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => /^v\d+$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// Create vN+1 from a parent plus changed files. Rejects edits outside the evolvable set.
export function createVariant(store: Store, parent: string, files: Record<string, string>, rationale: string, parents?: string[]): string {
  for (const name of Object.keys(files)) {
    if (!EVOLVABLE_FILES.includes(name)) throw new Error(`Evolver may not edit ${name}`);
  }
  if (files['config.json']) {
    const next = JSON.parse(files['config.json']) as HarnessConfig;
    const prev = loadHarness(store, parent).config;
    // Guard against the cheapest way to "improve": lowering the bar.
    if (next.passThreshold < prev.passThreshold) throw new Error('Evolver may not lower passThreshold');
    for (const role of ROLES) if (!next.models?.[role]) throw new Error(`config.json missing models.${role}`);
  }
  const versions = listVersions(store);
  const nextNum = Math.max(0, ...versions.map((v) => Number(v.slice(1)))) + 1;
  const version = `v${nextNum}`;
  const dest = store.path('harness', version);
  cpSync(store.path('harness', parent), dest, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dest, name), content);
  const archive = readArchive(store);
  archive.push({ version, parent, createdAt: Date.now(), rationale, evalScore: null, status: 'candidate', ...(parents?.length ? { parents } : {}) });
  writeArchive(store, archive);
  return version;
}

export function promote(store: Store, version: string): void {
  if (!existsSync(store.path('harness', version))) throw new Error(`No harness ${version}`);
  const prev = currentVersion(store);
  const archive = readArchive(store).map((a) => {
    if (a.version === version) return { ...a, status: 'promoted' as const };
    if (a.version === prev && prev !== version) return { ...a, status: 'retired' as const };
    return a;
  });
  writeArchive(store, archive);
  store.writeText('harness/current', version + '\n');
}

export function readArchive(store: Store): ArchiveEntry[] {
  return store.readJson<ArchiveEntry[]>('archive.json', []);
}

export function writeArchive(store: Store, entries: ArchiveEntry[]): void {
  store.writeJson('archive.json', entries);
}

export function updateArchive(store: Store, version: string, patch: Partial<ArchiveEntry>): void {
  writeArchive(
    store,
    readArchive(store).map((a) => (a.version === version ? { ...a, ...patch } : a)),
  );
}
