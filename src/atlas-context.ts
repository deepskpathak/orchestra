// Pure renderers over the Atlas graph: personalised PageRank file ranking, the L0 repo map and the
// L1 task pack. No IO and no clock, so output is deterministic for the same inputs.
// Type-only import: this module must stay free of fs / child_process.
import type { Atlas, AtlasSymbol } from './atlas.ts';

export interface Footprint {
  files: string[];
  symbols?: string[];
}

export interface RankedFile {
  path: string;
  score: number;
}

// Rough chars/4 estimate, shared by the map and pack budgets.
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'make', 'use', 'new', 'should', 'when', 'all']);
const DAMPING = 0.85;
const ITERATIONS = 40;
const FORWARD_WEIGHT = 0.5; // rank flows to what a matching file imports, at half the strength of the importer direction
const MAX_SYMS_PER_FILE = 12;
const MAX_LIST = 12;

// Defence in depth: the atlas never indexes these, and footprint / changed paths come from outside it.
function excluded(path: string): boolean {
  const segs = path.replace(/\\/g, '/').split('/');
  return segs.includes('.orchestra') || (segs[segs.length - 1] ?? '').startsWith('.env');
}

function goalTerms(goal: string): string[] {
  const terms = goal.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
  return [...new Set(terms)].sort();
}

function sortedPaths(atlas: Atlas): string[] {
  return Object.keys(atlas.files).filter((p) => !excluded(p)).sort();
}

// file -> file adjacency (imports, references, tests), importer direction weighted highest.
function adjacency(atlas: Atlas, paths: string[]): Map<string, Map<string, number>> {
  const known = new Set(paths);
  const pathOf = (id: string): string => {
    if (known.has(id)) return id;
    const i = id.indexOf('#');
    return i >= 0 ? id.slice(0, i) : id;
  };
  const adj = new Map<string, Map<string, number>>();
  for (const p of paths) adj.set(p, new Map());
  const add = (a: string, b: string, w: number) => {
    const m = adj.get(a);
    if (m) m.set(b, (m.get(b) ?? 0) + w);
  };
  const edges = atlas.edges
    .filter((e) => e.kind !== 'contains')
    .map((e) => ({ from: pathOf(e.from), to: pathOf(e.to) }))
    .filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  for (const e of edges) {
    add(e.to, e.from, 1); // importers and callers of a matching file rank first
    add(e.from, e.to, FORWARD_WEIGHT);
  }
  return adj;
}

export function rankFiles(atlas: Atlas, goal: string): RankedFile[] {
  const paths = sortedPaths(atlas);
  const n = paths.length;
  if (!n) return [];
  const terms = goalTerms(goal);
  const seed = new Map<string, number>();
  let total = 0;
  for (const p of paths) {
    const lp = p.toLowerCase();
    const syms = atlas.files[p].symbols.map((s) => s.name.toLowerCase());
    let hits = 0;
    for (const t of terms) {
      if (lp.includes(t)) hits += 2;
      if (syms.some((s) => s.includes(t))) hits += 1;
    }
    if (hits) {
      seed.set(p, hits);
      total += hits;
    }
  }
  const pers = new Map<string, number>();
  for (const p of paths) pers.set(p, total ? (seed.get(p) ?? 0) / total : 1 / n);

  const adj = adjacency(atlas, paths);
  const out = new Map<string, number>();
  for (const p of paths) {
    let s = 0;
    for (const w of adj.get(p)!.values()) s += w;
    out.set(p, s);
  }
  let rank = new Map(pers);
  for (let it = 0; it < ITERATIONS; it++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const p of paths) if (!out.get(p)) dangling += rank.get(p)!;
    for (const p of paths) next.set(p, (1 - DAMPING) * pers.get(p)! + DAMPING * dangling * pers.get(p)!);
    for (const p of paths) {
      const o = out.get(p)!;
      if (!o) continue;
      const share = (DAMPING * rank.get(p)!) / o;
      for (const [q, w] of adj.get(p)!) next.set(q, next.get(q)! + share * w);
    }
    rank = next;
  }
  return paths
    .map((path) => ({ path, score: rank.get(path)! }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function signature(s: AtlasSymbol): string {
  return `${s.kind} ${s.name}`;
}

function fileSymbols(atlas: Atlas, path: string, only?: string[]): AtlasSymbol[] {
  const all = atlas.files[path]?.symbols ?? [];
  if (only?.length) {
    const hit = all.filter((s) => only.some((o) => s.name === o || s.name.endsWith(`.${o}`)));
    if (hit.length) return hit;
  }
  const exported = all.filter((s) => s.exported);
  return exported.length ? exported : all;
}

function symLines(syms: AtlasSymbol[], indent: string): string[] {
  const lines = syms.slice(0, MAX_SYMS_PER_FILE).map((s) => `${indent}${signature(s)}:${s.line}`);
  if (syms.length > MAX_SYMS_PER_FILE) lines.push(`${indent}... +${syms.length - MAX_SYMS_PER_FILE} more`);
  return lines;
}

function renderTree(atlas: Atlas, files: string[]): string {
  const sorted = [...files].sort();
  const lines: string[] = [];
  const open: string[] = [];
  for (const p of sorted) {
    const segs = p.split('/');
    const dirs = segs.slice(0, -1);
    let common = 0;
    while (common < open.length && common < dirs.length && open[common] === dirs[common]) common++;
    open.length = common;
    for (let i = common; i < dirs.length; i++) {
      lines.push(`${'  '.repeat(i)}${dirs[i]}/`);
      open.push(dirs[i]);
    }
    const ind = '  '.repeat(dirs.length);
    lines.push(`${ind}${segs[segs.length - 1]}`);
    lines.push(...symLines(fileSymbols(atlas, p), `${ind}  `));
  }
  return lines.join('\n');
}

// L0 map: the highest-ranked files as a directory tree with exported symbol signatures, trimmed to
// the largest ranked prefix that fits mapTokens. Returns '' when nothing fits.
export function renderMap(atlas: Atlas, goal: string, mapTokens: number): string {
  const ranked = rankFiles(atlas, goal).map((r) => r.path);
  const head = '# Repo map (ranked by relevance to the goal)\n';
  const render = (k: number) => head + renderTree(atlas, ranked.slice(0, k)) + '\n';
  let lo = 0;
  let hi = ranked.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(render(mid)) <= mapTokens) lo = mid;
    else hi = mid - 1;
  }
  return lo ? render(lo) : '';
}

// L1 task pack: skeletons (signatures only) for the footprint, 1-hop importers/callers, related
// tests and files changed on integration since run start, trimmed to packTokens.
export function buildTaskPack(atlas: Atlas, footprint: Footprint, changedSinceStart: string[], packTokens: number): string {
  const fpFiles = [...new Set(footprint.files ?? [])].filter((p) => !excluded(p)).sort();
  const changed = [...new Set(changedSinceStart)].filter((p) => !excluded(p)).sort();
  if (!fpFiles.length && !changed.length) return '';

  const inIndex = (p: string) => !!atlas.files[p];
  const fpSet = new Set(fpFiles.filter(inIndex));
  const pathOf = (id: string) => {
    const i = id.indexOf('#');
    return i >= 0 ? id.slice(0, i) : id;
  };
  const isTest = new Set<string>();
  const importers = new Set<string>();
  for (const e of atlas.edges) {
    if (e.kind === 'contains') continue;
    const from = pathOf(e.from);
    const to = pathOf(e.to);
    if (from === to || !fpSet.has(to) || fpSet.has(from) || !inIndex(from) || excluded(from)) continue;
    if (e.kind === 'tests') isTest.add(from);
    else importers.add(from);
  }
  const tests = [...isTest].sort();
  const callers = [...importers].filter((p) => !isTest.has(p)).sort();

  const lines: string[] = ['## Task pack'];
  // Skeletons come from the atlas at the base commit, so a file changed on integration is flagged
  // rather than presented as current.
  const changedSet = new Set(changed);
  const section = (title: string, items: string[], withSyms: boolean, only?: string[]) => {
    if (!items.length) return;
    lines.push(`${title}:`);
    for (const p of items.slice(0, MAX_LIST * 2)) {
      lines.push(withSyms && inIndex(p) && changedSet.has(p) ? `  ${p} (changed since base; symbols and lines as of the base commit)` : `  ${p}`);
      if (withSyms && inIndex(p)) lines.push(...symLines(fileSymbols(atlas, p, only), '    '));
    }
    if (items.length > MAX_LIST * 2) lines.push(`  ... +${items.length - MAX_LIST * 2} more`);
  };
  section('Footprint', fpFiles.filter(inIndex), true, footprint.symbols);
  const missing = fpFiles.filter((p) => !inIndex(p));
  if (missing.length) lines.push(`Not in index: ${missing.join(', ')}`);
  section('Importers and callers', callers, true);
  section('Related tests', tests, false);
  section('Changed on integration since run start', changed, true);

  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    const cost = estimateTokens(l + '\n');
    if (used + cost > packTokens) break;
    kept.push(l);
    used += cost;
  }
  return kept.length > 1 ? kept.join('\n') + '\n' : '';
}
