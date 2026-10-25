// Optional external atlas inputs (W9.5): universal-ctags output and a graphify graph.json are mapped
// onto the same node and edge types src/atlas.ts produces. Never required and never networked: every
// probe (exec, file read) is injected, and any miss degrades to the built-in source with a reason.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Atlas, AtlasEdge, AtlasNode, EdgeKind, SymbolKind } from './atlas.ts';

export type ExternalMode = 'off' | 'auto' | 'ctags' | 'graphify';
export const EXTERNAL_MODES: ExternalMode[] = ['off', 'auto', 'ctags', 'graphify'];
export type ExecFn = (cmd: string, args: string[], cwd: string) => string; // returns stdout, throws on failure
export type ReadFn = (path: string) => string | null; // null when absent

export interface ExternalGraph {
  source: 'ctags' | 'graphify';
  nodes: AtlasNode[]; // symbol (and, for graphify, file) nodes
  edges: AtlasEdge[];
}

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
      const g = loadGraphify(root, opts.read);
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
    const g = parseCtagsJson(execFn('ctags', ['--output-format=json', '--fields=+nK', '-R', '-f', '-', '.'], root));
    log(`Atlas merged ${g.nodes.length} nodes from ctags`);
    return mergeExternal(atlas, g);
  } catch (e) {
    return fallback((e as Error).message.split('\n')[0]);
  }
}
