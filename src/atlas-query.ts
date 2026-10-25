// L2 atlas queries (W9.3): pure functions over the Atlas graph that render tree-format text for
// `orchestra atlas find|neighbors|impact|tests`. No IO and no clock; the CLI supplies the stale set
// from `git status`. Output is advisory only and never gates a merge.
// Type-only import: this module must stay free of fs / child_process.
import type { Atlas, AtlasNode } from './atlas.ts';

export const DEFAULT_QUERY_CAP = 80;
export const STALE_MARK = '(stale: read the file)';

export interface QueryOpts {
  cap?: number; // max output lines, truncation marker included
  stale?: Iterable<string>; // repo-relative paths modified in the calling worktree
}

export interface QueryResult {
  found: boolean;
  text: string;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const fileOf = (id: string): string => {
  const i = id.indexOf('#');
  return i >= 0 ? id.slice(0, i) : id;
};

// Paths from `git status --porcelain` lines. Renames ("R  old -> new") yield the new path.
export function parsePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    paths.push(norm(p));
  }
  return paths;
}

function cap(lines: string[], limit: number): string {
  const max = Math.max(2, limit);
  if (lines.length <= max) return lines.join('\n');
  const keep = lines.slice(0, max - 1);
  keep.push(`... truncated, ${lines.length - keep.length} more lines (cap ${max})`);
  return keep.join('\n');
}

const sym = (n: AtlasNode): string => `${n.name} (${n.symKind ?? 'symbol'}, line ${n.line ?? '?'}${n.exported ? ', exported' : ''})`;

// Resolve a query to files and symbol nodes: exact path, path suffix, then symbol name (exact, then
// the unqualified part of Class.method). Substring matching is a last resort so typos still help.
function resolve(atlas: Atlas, q: string): { files: string[]; symbols: AtlasNode[] } {
  const query = norm(q.trim());
  const paths = Object.keys(atlas.files).sort();
  const symbols = atlas.nodes.filter((n) => n.kind === 'symbol').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (atlas.files[query]) return { files: [query], symbols: [] };
  const suffix = paths.filter((p) => p.endsWith('/' + query));
  const exactSym = symbols.filter((s) => s.name === query || s.name.split('.').pop() === query);
  if (suffix.length || exactSym.length) return { files: suffix, symbols: exactSym };
  const lower = query.toLowerCase();
  if (!lower) return { files: [], symbols: [] };
  return {
    files: paths.filter((p) => p.toLowerCase().includes(lower)),
    symbols: symbols.filter((s) => s.name.toLowerCase().includes(lower)),
  };
}

function marker(stale: Set<string>, file: string): string {
  return stale.has(file) ? ` ${STALE_MARK}` : '';
}

function ctx(opts?: QueryOpts): { limit: number; stale: Set<string> } {
  return { limit: opts?.cap ?? DEFAULT_QUERY_CAP, stale: new Set([...(opts?.stale ?? [])].map(norm)) };
}

const miss = (what: string, q: string): QueryResult => ({ found: false, text: `${what}: nothing found for "${q}"` });

// Files that depend on `file` through edges of the given kinds, with the edge kind and (for
// symbol-level references) the referenced symbol.
function inbound(atlas: Atlas, file: string, kinds: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of atlas.edges) {
    if (!kinds.includes(e.kind) || fileOf(e.to) !== file) continue;
    const from = fileOf(e.from);
    if (from === file) continue;
    const set = out.get(from) ?? new Set<string>();
    set.add(e.to.includes('#') ? `${e.kind} ${e.to.slice(e.to.indexOf('#') + 1)}` : e.kind);
    out.set(from, set);
  }
  return out;
}

function outbound(atlas: Atlas, file: string, kinds: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of atlas.edges) {
    if (!kinds.includes(e.kind) || fileOf(e.from) !== file) continue;
    const to = fileOf(e.to);
    if (to === file) continue;
    const set = out.get(to) ?? new Set<string>();
    set.add(e.kind);
    out.set(to, set);
  }
  return out;
}

const sortedKeys = <V>(m: Map<string, V>): string[] => [...m.keys()].sort();

// find: files and symbols matching a name or path.
export function find(atlas: Atlas, q: string, opts?: QueryOpts): QueryResult {
  const { limit, stale } = ctx(opts);
  const r = resolve(atlas, q);
  if (!r.files.length && !r.symbols.length) return miss('find', q);
  const lines = [`find "${q}"`];
  const fileList = r.files;
  const symByFile = new Map<string, AtlasNode[]>();
  for (const s of r.symbols) symByFile.set(s.path, [...(symByFile.get(s.path) ?? []), s]);
  const all = [...new Set([...fileList, ...symByFile.keys()])].sort();
  all.forEach((f, i) => {
    const last = i === all.length - 1;
    lines.push(`${last ? '└── ' : '├── '}${f}${marker(stale, f)}`);
    const pad = last ? '    ' : '│   ';
    const syms = fileList.includes(f) && !symByFile.has(f) ? [] : symByFile.get(f) ?? [];
    syms.forEach((s, j) => lines.push(`${pad}${j === syms.length - 1 ? '└── ' : '├── '}${sym(s)}`));
  });
  return { found: true, text: cap(lines, limit) };
}

// neighbors: what a file imports/references and what imports/references it.
export function neighbors(atlas: Atlas, q: string, opts?: QueryOpts): QueryResult {
  const { limit, stale } = ctx(opts);
  const files = resolve(atlas, q);
  const target = files.files[0] ?? files.symbols[0]?.path;
  if (!target) return miss('neighbors', q);
  const kinds = ['imports', 'references', 'tests'];
  const lines = [`neighbors of ${target}${marker(stale, target)}`];
  const groups: [string, Map<string, Set<string>>][] = [['imports', outbound(atlas, target, kinds)], ['imported by', inbound(atlas, target, kinds)]];
  groups.forEach(([label, m], gi) => {
    const lastGroup = gi === groups.length - 1;
    lines.push(`${lastGroup ? '└── ' : '├── '}${label} (${m.size})`);
    const pad = lastGroup ? '    ' : '│   ';
    sortedKeys(m).forEach((f, i, a) => lines.push(`${pad}${i === a.length - 1 ? '└── ' : '├── '}${f} [${[...m.get(f)!].sort().join(', ')}]${marker(stale, f)}`));
  });
  return { found: true, text: cap(lines, limit) };
}

// impact: everything that would be affected by changing a file or symbol. Advisory only.
export function impact(atlas: Atlas, q: string, opts?: QueryOpts): QueryResult {
  const { limit, stale } = ctx(opts);
  const r = resolve(atlas, q);
  const targets = [...new Set([...r.files, ...r.symbols.map((s) => s.path)])].sort();
  if (!targets.length) return miss('impact', q);
  const lines = [`impact of ${q}`];
  const callersOf = (f: string) => inbound(atlas, f, ['imports', 'references']);
  targets.forEach((t, ti) => {
    const lastT = ti === targets.length - 1;
    const callers = callersOf(t);
    const tests = inbound(atlas, t, ['tests']);
    lines.push(`${lastT ? '└── ' : '├── '}${t}${marker(stale, t)}`);
    const pad = lastT ? '    ' : '│   ';
    lines.push(`${pad}├── callers/importers (${callers.size})`);
    sortedKeys(callers).forEach((f, i, a) => {
      lines.push(`${pad}│   ${i === a.length - 1 ? '└── ' : '├── '}${f} [${[...callers.get(f)!].sort().join(', ')}]${marker(stale, f)}`);
    });
    lines.push(`${pad}└── tests (${tests.size})`);
    sortedKeys(tests).forEach((f, i, a) => lines.push(`${pad}    ${i === a.length - 1 ? '└── ' : '├── '}${f}${marker(stale, f)}`));
  });
  // Advisory repair notes: dependents the calling worktree has not touched while the target changed.
  const notes: string[] = [];
  for (const t of targets) {
    if (!stale.has(t)) continue;
    const untouched = sortedKeys(callersOf(t)).filter((f) => !stale.has(f));
    if (untouched.length) notes.push(`advisory: ${t} is modified but callers not updated: ${untouched.join(', ')}`);
  }
  if (notes.length) lines.push('', ...notes);
  return { found: true, text: cap(lines, limit) };
}

// tests: test files that import (or are named after) a file.
export function tests(atlas: Atlas, q: string, opts?: QueryOpts): QueryResult {
  const { limit, stale } = ctx(opts);
  const r = resolve(atlas, q);
  const targets = [...new Set([...r.files, ...r.symbols.map((s) => s.path)])].sort();
  if (!targets.length) return miss('tests', q);
  const lines = [`tests for ${q}`];
  targets.forEach((t, ti) => {
    const lastT = ti === targets.length - 1;
    const found = inbound(atlas, t, ['tests', 'imports', 'references']);
    const testFiles = sortedKeys(found).filter((f) => atlas.edges.some((e) => e.kind === 'tests' && fileOf(e.from) === f) || /(^|\/)(tests?|__tests__)\/|[._]test\.|[._]spec\.|_test\.|(^|\/)test_/.test(f));
    lines.push(`${lastT ? '└── ' : '├── '}${t}${marker(stale, t)}`);
    const pad = lastT ? '    ' : '│   ';
    if (!testFiles.length) lines.push(`${pad}└── (no test files found)`);
    testFiles.forEach((f, i) => lines.push(`${pad}${i === testFiles.length - 1 ? '└── ' : '├── '}${f}${marker(stale, f)}`));
  });
  return { found: true, text: cap(lines, limit) };
}

export const QUERY_COMMANDS = ['find', 'neighbors', 'impact', 'tests'] as const;
export type QueryCommand = (typeof QUERY_COMMANDS)[number];

export function runQuery(atlas: Atlas, cmd: QueryCommand, arg: string, opts?: QueryOpts): QueryResult {
  switch (cmd) {
    case 'find':
      return find(atlas, arg, opts);
    case 'neighbors':
      return neighbors(atlas, arg, opts);
    case 'impact':
      return impact(atlas, arg, opts);
    case 'tests':
      return tests(atlas, arg, opts);
  }
}

// One line for worker and judge prompts when context.atlas.query is on.
export const ATLAS_QUERY_HINT =
  'CODE GRAPH: run `orchestra atlas find|neighbors|impact|tests <symbol-or-path>` via Bash for callers, importers and related tests. Entries marked (stale: read the file) changed in your worktree; results are advisory.';
