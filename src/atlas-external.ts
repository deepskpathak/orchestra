// Optional external atlas inputs (W9.5): universal-ctags output and a graphify graph.json are mapped
// onto the same node and edge types src/atlas.ts produces. Never required and never networked: every
// probe (exec, file read) is injected, and any miss degrades to the built-in source with a reason.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Atlas, AtlasEdge, AtlasNode, EdgeKind, SymbolKind } from './atlas.ts';
import { readBlobsAtRef, tryGit } from './git.ts';
import { Store } from './store.ts';

export type ExternalMode = 'off' | 'auto' | 'ctags' | 'graphify';
export const EXTERNAL_MODES: ExternalMode[] = ['off', 'auto', 'ctags', 'graphify'];
export type ExecFn = (cmd: string, args: string[], cwd: string, input?: string) => string; // returns stdout, throws on failure
export type ReadFn = (path: string) => string | null; // null when absent

export interface ExternalGraph {
  source: 'ctags' | 'graphify';
  nodes: AtlasNode[]; // symbol (and, for graphify, file) nodes
  edges: AtlasEdge[];
}

// Real exec for the optional ctags probe: stdout on success, throws when the binary is missing or fails.
export function ctagsExec(cmd: string, args: string[], cwd: string, input?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? `${cmd} exited ${r.status}`);
  return r.stdout;
}

// Never indexed, even if a path under them slips into the file list.
const CTAGS_EXCLUDES = ['.git', '.orchestra', 'node_modules'];
const CTAGS_CACHE_KEEP = 5;
const CTAGS_MAX_FILE_BYTES = 1024 * 1024;

const GRAPHIFY_PATHS = ['graphify-out/graph.json', 'graph.json'];

const CTAGS_KINDS: Record<string, SymbolKind> = {
  function: 'function', func: 'function', procedure: 'function', subroutine: 'function',
  class: 'class', struct: 'class', module: 'class', namespace: 'class', trait: 'class',
  method: 'method', member: 'method',
  interface: 'type', type: 'type', typedef: 'type', enum: 'type', alias: 'type',
  constant: 'const', const: 'const', variable: 'const',
};

const EDGE_RELATIONS: Record<string, EdgeKind> = {
  contains: 'contains', defines: 'contains', defined_in: 'contains',
  imports: 'imports', imports_from: 'imports', import: 'imports',
  calls: 'references', references: 'references', uses: 'references', inherits: 'references', extends: 'references',
  tests: 'tests',
};

// Detect-and-degrade, same pattern as the srt probe in the sandbox preflight. Universal ctags prints
// "Universal Ctags" in --version; Exuberant or BSD ctags lack JSON output and are rejected.
export function detectCtags(execFn: ExecFn, cwd = '.'): { available: boolean; reason: string } {
  try {
    const out = execFn('ctags', ['--version'], cwd);
    if (/universal ctags/i.test(out)) return { available: true, reason: 'universal-ctags found' };
    return { available: false, reason: 'ctags on PATH is not universal-ctags' };
  } catch {
    return { available: false, reason: 'ctags not found on PATH' };
  }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

// Pure: `ctags --output-format=json` lines (one object per line) to symbol nodes and contains edges.
// Malformed lines, pseudo-tags and unknown kinds are skipped. Qualified names use scope (Class.method).
export function parseCtagsJson(output: string): ExternalGraph {
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let t: Record<string, unknown>;
    try {
      t = JSON.parse(line);
    } catch {
      continue;
    }
    if (t._type !== 'tag' || typeof t.name !== 'string' || typeof t.path !== 'string') continue;
    const symKind = CTAGS_KINDS[String(t.kind ?? '').toLowerCase()];
    if (!symKind) continue;
    const path = norm(t.path);
    const name = typeof t.scope === 'string' && t.scope ? `${t.scope}.${t.name}` : t.name;
    const id = `${path}#${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, kind: 'symbol', path, name, symKind, line: typeof t.line === 'number' ? t.line : undefined, exported: false });
    edges.push({ from: path, to: id, kind: 'contains' });
  }
  return { source: 'ctags', nodes, edges };
}

// Reads the first graphify graph.json found under root. Returns null when none exists or it is not
// valid JSON. Maps node-link `nodes`/`links` (networkx shape) to atlas types and ignores unknown kinds.
export function loadGraphify(root: string, readFn: ReadFn = defaultRead(root)): ExternalGraph | null {
  let doc: unknown = null;
  for (const rel of GRAPHIFY_PATHS) {
    const text = readFn(join(root, rel));
    if (text === null) continue;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    break;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as { nodes?: unknown; links?: unknown; edges?: unknown };
  const rawNodes = Array.isArray(d.nodes) ? d.nodes : [];
  const rawLinks = Array.isArray(d.links) ? d.links : Array.isArray(d.edges) ? d.edges : [];
  const nodes: AtlasNode[] = [];
  const idMap = new Map<string, string>(); // graphify id -> atlas id
  for (const n of rawNodes as Record<string, unknown>[]) {
    if (!n || typeof n !== 'object') continue;
    const gid = n.id === undefined ? '' : String(n.id);
    const path = typeof n.source_file === 'string' ? norm(n.source_file) : typeof n.path === 'string' ? norm(n.path) : '';
    const label = typeof n.label === 'string' ? n.label : typeof n.name === 'string' ? n.name : '';
    if (!gid || !path || !label) continue;
    const kind = String(n.kind ?? n.file_type ?? '').toLowerCase();
    const loc = /(\d+)/.exec(String(n.source_location ?? n.line ?? ''));
    const line = loc ? Number(loc[1]) : undefined;
    if (kind === 'file' || label === path || label === path.slice(path.lastIndexOf('/') + 1)) {
      nodes.push({ id: path, kind: 'file', path, name: path.slice(path.lastIndexOf('/') + 1) });
      idMap.set(gid, path);
      continue;
    }
    const symKind = CTAGS_KINDS[kind] ?? (kind === 'code' ? 'function' : undefined);
    if (!symKind) continue; // unknown kind: ignored
    const name = label.replace(/\(\)$/, '');
    const id = `${path}#${name}`;
    nodes.push({ id, kind: 'symbol', path, name, symKind, line, exported: false });
    idMap.set(gid, id);
  }
  const edges: AtlasEdge[] = [];
  for (const l of rawLinks as Record<string, unknown>[]) {
    if (!l || typeof l !== 'object') continue;
    const kind = EDGE_RELATIONS[String(l.relation ?? l.kind ?? '').toLowerCase()];
    const from = idMap.get(String(l.source));
    const to = idMap.get(String(l.target));
    if (kind && from && to && from !== to) edges.push({ from, to, kind });
  }
  return { source: 'graphify', nodes, edges };
}

function defaultRead(_root: string): ReadFn {
  return (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
}

// The graph as committed at `sha`, so the same commit always yields the same graph whatever checkout or
// worktree asks. graphify output is often left untracked; then fall back to the checkout's copy and say so.
function readAtCommit(root: string, sha: string, log: (msg: string) => void): ReadFn {
  const disk = defaultRead(root);
  return (p) => {
    const rel = relative(root, p).replace(/\\/g, '/');
    const r = tryGit(root, 'show', `${sha}:${rel}`);
    if (r.ok) return r.out;
    const text = disk(p);
    if (text !== null) log(`Atlas graphify ${rel} is not committed at ${sha.slice(0, 8)}; using the working-tree copy, which may differ between checkouts`);
    return text;
  };
}

// ctags runs on the atlas commit's own files (blobs written to a scratch directory), never on the live
// checkout, so untracked output, build directories and edits made after the commit cannot leak in. Output is
// cached by sha, and the probe cannot rescan the repository on every start.
function ctagsGraph(root: string, atlas: Atlas, execFn: ExecFn, log: (msg: string) => void): ExternalGraph {
  const store = new Store(root);
  const rel = `atlas-ctags/${atlas.sha}.jsonl`;
  const cached = store.readText(rel);
  if (cached) return parseCtagsJson(cached);
  const paths = Object.keys(atlas.files).filter((f) => !f.split('/').some((seg) => CTAGS_EXCLUDES.includes(seg)));
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-ctags-'));
  let out: string;
  try {
    const written: string[] = [];
    for (const [p, buf] of readBlobsAtRef(root, atlas.sha, paths, CTAGS_MAX_FILE_BYTES)) {
      if (!buf) continue;
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), buf);
      written.push(p);
    }
    if (!written.length) return { source: 'ctags', nodes: [], edges: [] };
    out = execFn('ctags', ['--output-format=json', '--fields=+nK', ...CTAGS_EXCLUDES.map((e) => `--exclude=${e}`), '-L', '-', '-f', '-'], dir, written.join('\n') + '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  store.writeText(rel, out);
  pruneCtagsCache(store, atlas.sha);
  log(`Atlas ctags output cached for ${atlas.sha.slice(0, 8)}`);
  return parseCtagsJson(out);
}

function pruneCtagsCache(store: Store, keep: string): void {
  const d = store.path('atlas-ctags');
  if (!existsSync(d)) return;
  const old = readdirSync(d)
    .filter((f) => f.endsWith('.jsonl') && f !== `${keep}.jsonl`)
    .map((f) => ({ f, t: statSync(join(d, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(CTAGS_CACHE_KEEP - 1);
  for (const { f } of old) unlinkSync(join(d, f));
}

// Returns a new atlas with the external nodes and edges added. Only paths already in the built-in
// atlas are accepted (so excluded and secret paths stay out); duplicates and dangling edges are dropped.
export function mergeExternal(atlas: Atlas, ext: ExternalGraph): Atlas {
  const ids = new Set(atlas.nodes.map((n) => n.id));
  const nodes = [...atlas.nodes];
  for (const n of ext.nodes) {
    if (!(n.path in atlas.files) || ids.has(n.id)) continue;
    ids.add(n.id);
    nodes.push(n);
  }
  const seen = new Set(atlas.edges.map((e) => `${e.kind}|${e.from}|${e.to}`));
  const edges = [...atlas.edges];
  for (const e of ext.edges) {
    const key = `${e.kind}|${e.from}|${e.to}`;
    if (seen.has(key) || !ids.has(e.from) || !ids.has(e.to)) continue;
    seen.add(key);
    edges.push(e);
  }
  return { ...atlas, nodes, edges };
}

export interface ExternalOpts {
  mode: ExternalMode;
  exec?: ExecFn;
  read?: ReadFn;
  log?: (msg: string) => void;
}

// Applies the configured external source to a built-in atlas. Never throws: any miss logs the reason
// and returns the atlas unchanged.
export function applyExternal(root: string, atlas: Atlas, opts: ExternalOpts): Atlas {
  const { mode } = opts;
  if (mode === 'off') return atlas;
  const log = opts.log ?? (() => {});
  const fallback = (why: string) => {
    log(`Atlas external source (${mode}) unavailable, using built-in: ${why}`);
    return atlas;
  };
  try {
    if (mode === 'graphify' || mode === 'auto') {
      const g = loadGraphify(root, opts.read ?? readAtCommit(root, atlas.sha, log));
      if (g) {
        log(`Atlas merged ${g.nodes.length} nodes from graphify`);
        return mergeExternal(atlas, g);
      }
      if (mode === 'graphify') return fallback('no readable graph.json');
    }
    const execFn = opts.exec;
    if (!execFn) return fallback('no exec available');
    const det = detectCtags(execFn, root);
    if (!det.available) return fallback(det.reason);
    const g = ctagsGraph(root, atlas, execFn, log);
    log(`Atlas merged ${g.nodes.length} nodes from ctags`);
    return mergeExternal(atlas, g);
  } catch (e) {
    return fallback((e as Error).message.split('\n')[0]);
  }
}
