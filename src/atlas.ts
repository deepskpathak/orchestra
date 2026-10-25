// Repo Atlas (W9): a deterministic, commit-keyed code graph. Nodes are dirs, files and symbols;
// edges are contains, imports, references and tests. Extraction is regex based (no parser, no LLM,
// no dependency) with a file-level fallback for any other text file. The extractors are pure
// functions of source text. Cached at .orchestra/atlas/<sha>.json and rebuilt incrementally from
// the nearest cached commit. Never indexes the Orchestra state dir, .env* or guard secret paths.

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { commitExists, diffNamesBetween, filesAtRef, git, readBlobsAtRef, tryGit } from './git.ts';
import { isSecretPath } from './guard.ts';
import { Store } from './store.ts';

export const ATLAS_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 500;
const MAX_NEAREST_CANDIDATES = 8;
const MAX_CACHED_ATLASES = 16;
// Extensions that are never source text; skipped before any blob is read.
const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|class|so|dylib|dll|exe|o|a|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|wav|ogg|sqlite|db|parquet|lock)$/i;

export type SymbolKind = 'function' | 'class' | 'method' | 'type' | 'const';

export interface AtlasSymbol {
  name: string; // qualified for methods (Class.method)
  kind: SymbolKind;
  line: number; // 1-based
  exported: boolean;
}

export interface ImportRef {
  spec: string; // module specifier as written
  names: string[]; // bindings pulled in (original names); empty for side-effect, namespace or whole-module imports
  mod?: boolean; // Rust `mod x;`
}

export interface Extracted {
  symbols: AtlasSymbol[];
  imports: ImportRef[];
}

export interface FileEntry extends Extracted {
  lang: string;
  goModule?: string; // go.mod only: the declared module path
  size: number;
  lines: number;
}

export type NodeKind = 'dir' | 'file' | 'symbol';
export type EdgeKind = 'contains' | 'imports' | 'references' | 'tests';

export interface AtlasNode {
  id: string; // dir: "<path>/" ("./" for the root); file: path; symbol: "<path>#<name>"
  kind: NodeKind;
  path: string;
  name: string;
  lang?: string;
  symKind?: SymbolKind;
  line?: number;
  exported?: boolean;
}

export interface AtlasEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Atlas {
  version: number;
  sha: string;
  files: Record<string, FileEntry>;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export interface AtlasStats {
  files: number;
  dirs: number;
  symbols: number;
  edges: Record<EdgeKind, number>;
  languages: Record<string, number>;
}

// ---- exclusions ----

// True for anything the atlas must never index: the Orchestra state dir at any depth, .env* files
// and the guard's secret path pattern.
export function isExcludedPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  const segs = p.split('/');
  if (segs.includes('.orchestra')) return true;
  if ((segs[segs.length - 1] ?? '').startsWith('.env')) return true;
  return isSecretPath(p);
}

// ---- language detection ----

const EXT_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'python', go: 'go', java: 'java', rs: 'rust',
};

export function languageOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT_LANG[m[1].toLowerCase()]) || 'text';
}

const isJsLike = (lang: string) => lang === 'ts' || lang === 'js';

// ---- extractors (pure: source text in, symbols and imports out) ----

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'function', 'do', 'try', 'throw', 'await', 'typeof', 'synchronized', 'super', 'this']);

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function uniqImports(list: ImportRef[]): ImportRef[] {
  const seen = new Set<string>();
  const out: ImportRef[] = [];
  for (const i of list) {
    const key = `${i.mod ? 'm:' : ''}${i.spec}|${i.names.join(',')}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(i);
    }
  }
  return out;
}

function parseNamedList(body: string): string[] {
  return body
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter((s) => /^[\w$]+$/.test(s));
}

export function extractTsJs(text: string): Extracted {
  const symbols: AtlasSymbol[] = [];
  const lines = text.split('\n');
  let cls: { name: string; indent: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ind = indentOf(line);
    if (cls && ind <= cls.indent && /^\s*\}/.test(line)) cls = null;
    let m: RegExpExecArray | null;
    if ((m = /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/.exec(line))) {
      symbols.push({ name: m[2], kind: 'class', line: i + 1, exported: !!m[1] });
      cls = { name: m[2], indent: ind };
    } else if ((m = /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(line))) {
      symbols.push({ name: m[2], kind: 'function', line: i + 1, exported: !!m[1] });
    } else if ((m = /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|enum)\s+([\w$]+)/.exec(line)) || (m = /^\s*(export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^=]*>)?\s*=/.exec(line))) {
      symbols.push({ name: m[2], kind: 'type', line: i + 1, exported: !!m[1] });
    } else if ((m = /^\s*export\s+(?:const|let|var)\s+([\w$]+)/.exec(line))) {
      symbols.push({ name: m[1], kind: 'const', line: i + 1, exported: true });
    } else if (cls && ind > cls.indent && (m = /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*([\w$]+)\s*(?:<[^>(]*>)?\s*\([^)]*\)?[^=;{]*\{/.exec(line)) && !KEYWORDS.has(m[1])) {
      symbols.push({ name: `${cls.name}.${m[1]}`, kind: 'method', line: i + 1, exported: false });
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  const imports: ImportRef[] = [];
  // Anchored per statement (line start) and the clause cannot contain another import/export keyword,
  // so in semicolon-less code an earlier `export ...` cannot swallow the next import.
  for (const m of text.matchAll(/^[ \t]*(import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[^'"`;])*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    const clause = m[3];
    const names: string[] = [];
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace) names.push(...parseNamedList(brace[1]));
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
    if (def && m[1] === 'import') names.push('default');
    imports.push({ spec: m[4], names });
  }
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) imports.push({ spec: m[1], names: [] });
  for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push({ spec: m[1], names: [] });
  return { symbols, imports: uniqImports(imports) };
}

export function extractPython(text: string): Extracted {
  const symbols: AtlasSymbol[] = [];
  const lines = text.split('\n');
  let cls: { name: string; indent: number; body: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = indentOf(line);
    if (cls && ind <= cls.indent && !/^\s*[@)]/.test(line)) cls = null;
    if (cls && cls.body < 0 && ind > cls.indent) cls.body = ind;
    let m: RegExpExecArray | null;
    if ((m = /^(\s*)class\s+(\w+)/.exec(line))) {
      if (ind === 0 || cls) symbols.push({ name: cls ? `${cls.name}.${m[2]}` : m[2], kind: 'class', line: i + 1, exported: ind === 0 && !m[2].startsWith('_') });
      if (ind === 0) cls = { name: m[2], indent: 0, body: -1 };
    } else if ((m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(line))) {
      if (ind === 0) symbols.push({ name: m[2], kind: 'function', line: i + 1, exported: !m[2].startsWith('_') });
      else if (cls && ind === cls.body) symbols.push({ name: `${cls.name}.${m[2]}`, kind: 'method', line: i + 1, exported: false });
    } else if (ind === 0 && (m = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/.exec(line))) {
      symbols.push({ name: m[1], kind: 'const', line: i + 1, exported: true });
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  const imports: ImportRef[] = [];
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const names = m[2]
      .replace(/[()]/g, '')
      .split(',')
      .map((s) => s.replace(/#.*$/, '').trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => /^\w+$/.test(s));
    imports.push({ spec: m[1], names });
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(spec)) imports.push({ spec, names: [] });
    }
  }
  return { symbols, imports: uniqImports(imports) };
}

export function extractGo(text: string): Extracted {
  const symbols: AtlasSymbol[] = [];
  const lines = text.split('\n');
  const cap = (n: string) => /^[A-Z]/.test(n);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^func\s+\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*(\w+)/.exec(line))) symbols.push({ name: `${m[1]}.${m[2]}`, kind: 'method', line: i + 1, exported: cap(m[2]) });
    else if ((m = /^func\s+(\w+)/.exec(line))) symbols.push({ name: m[1], kind: 'function', line: i + 1, exported: cap(m[1]) });
    else if ((m = /^type\s+(\w+)\s+(struct|interface)?/.exec(line))) symbols.push({ name: m[1], kind: m[2] === 'struct' ? 'class' : 'type', line: i + 1, exported: cap(m[1]) });
    else if ((m = /^(?:const|var)\s+(\w+)/.exec(line))) symbols.push({ name: m[1], kind: 'const', line: i + 1, exported: cap(m[1]) });
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  const imports: ImportRef[] = [];
  for (const m of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) imports.push({ spec: m[1], names: [] });
  for (const m of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) for (const q of m[1].matchAll(/"([^"]+)"/g)) imports.push({ spec: q[1], names: [] });
  return { symbols, imports: uniqImports(imports) };
}

export function extractJava(text: string): Extracted {
  const symbols: AtlasSymbol[] = [];
  const lines = text.split('\n');
  let cls: string | null = null;
  const mods = '(?:(?:public|protected|private|abstract|final|static|sealed|strictfp|synchronized|native|default)\\s+)*';
  const typeRe = new RegExp(`^\\s*(${mods})(?:class|interface|enum|record|@interface)\\s+(\\w+)`);
  const methodRe = new RegExp(`^\\s+(${mods})(?:<[^>]+>\\s+)?([\\w<>\\[\\],.?]+(?:\\s+[\\w<>\\[\\],.?]+)*?)\\s+(\\w+)\\s*\\([^;]*\\)\\s*(?:throws\\s+[\\w., ]+)?\\s*\\{?\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = typeRe.exec(line))) {
      const top = indentOf(line) === 0;
      symbols.push({ name: cls && !top ? `${cls}.${m[2]}` : m[2], kind: 'class', line: i + 1, exported: /\bpublic\b/.test(m[1]) });
      if (top) cls = m[2];
    } else if (cls && (m = methodRe.exec(line))) {
      const ret = m[2].split(/\s+/)[0];
      if (!KEYWORDS.has(ret) && !KEYWORDS.has(m[3])) symbols.push({ name: `${cls}.${m[3]}`, kind: 'method', line: i + 1, exported: /\bpublic\b/.test(m[1]) });
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  const imports: ImportRef[] = [];
  for (const m of text.matchAll(/^import\s+(static\s+)?([\w.]+?)(\.\*)?;/gm)) {
    if (m[3]) continue;
    const parts = m[2].split('.');
    const last = parts.pop() as string;
    imports.push(m[1] ? { spec: parts.join('.'), names: [last] } : { spec: m[2], names: [last] });
  }
  return { symbols, imports: uniqImports(imports) };
}

function expandUse(expr: string): string[] {
  const brace = /^(.*?)\{(.*)\}(.*)$/.exec(expr.trim());
  if (!brace) return [expr.trim().replace(/\s+as\s+\w+$/, '')];
  const [, pre, inner, post] = brace;
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.flatMap((p) => (p.trim() === 'self' ? [pre.replace(/::$/, '') + post] : expandUse(pre + p.trim() + post)));
}

export function extractRust(text: string): Extracted {
  const symbols: AtlasSymbol[] = [];
  const lines = text.split('\n');
  const vis = '(pub(?:\\([^)]*\\))?\\s+)?';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ind = indentOf(line);
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^\\s*${vis}(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+(\\w+)`).exec(line))) {
      symbols.push({ name: m[2], kind: ind === 0 ? 'function' : 'method', line: i + 1, exported: !!m[1] });
    } else if ((m = new RegExp(`^\\s*${vis}(struct|enum|trait|type|union)\\s+(\\w+)`).exec(line))) {
      symbols.push({ name: m[3], kind: m[2] === 'struct' ? 'class' : 'type', line: i + 1, exported: !!m[1] });
    } else if ((m = new RegExp(`^${vis}(?:const|static)\\s+(?:mut\\s+)?(\\w+)`).exec(line))) {
      symbols.push({ name: m[2], kind: 'const', line: i + 1, exported: !!m[1] });
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  const imports: ImportRef[] = [];
  for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm)) {
    for (const path of expandUse(m[1].replace(/\s+/g, ' '))) {
      const segs = path.split('::').filter(Boolean);
      if (segs.length) imports.push({ spec: segs.join('::'), names: [segs[segs.length - 1]] });
    }
  }
  for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+);/gm)) imports.push({ spec: m[1], names: [], mod: true });
  return { symbols, imports: uniqImports(imports) };
}

// Dispatches on the path's language. Unknown languages yield a file-level entry with no symbols.
export function extractFile(path: string, text: string): FileEntry {
  const lang = languageOf(path);
  let ex: Extracted = { symbols: [], imports: [] };
  if (isJsLike(lang)) ex = extractTsJs(text);
  else if (lang === 'python') ex = extractPython(text);
  else if (lang === 'go') ex = extractGo(text);
  else if (lang === 'java') ex = extractJava(text);
  else if (lang === 'rust') ex = extractRust(text);
  const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  const entry: FileEntry = { lang, size: Buffer.byteLength(text), lines, symbols: ex.symbols, imports: ex.imports };
  if (baseName(path) === 'go.mod') {
    const gm = /^module\s+("?)([^\s"]+)\1/m.exec(text);
    if (gm) entry.goModule = gm[2];
  }
  return entry;
}

// ---- import resolution and graph ----

const posixDir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function normalizeJoin(dir: string, rel: string): string {
  const out = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

interface Index {
  files: Set<string>;
  suffix: Map<string, string[]>; // every path suffix (by segment) to the files ending with it
  dirs: Map<string, string[]>; // dir -> files directly in it
  dirSuffix: Map<string, string[]>; // every dir suffix (by segment) to the dirs ending with it
  goMods: { dir: string; mod: string }[]; // go.mod locations, deepest first
}

function buildIndex(entries: Record<string, FileEntry>, paths: string[]): Index {
  const files = new Set(paths);
  const suffix = new Map<string, string[]>();
  const dirs = new Map<string, string[]>();
  const goMods: { dir: string; mod: string }[] = [];
  for (const p of paths) {
    const gm = entries[p].goModule;
    if (gm && baseName(p) === 'go.mod') goMods.push({ dir: posixDir(p), mod: gm });
    const segs = p.split('/');
    for (let i = 0; i < segs.length; i++) {
      const s = segs.slice(i).join('/');
      const list = suffix.get(s);
      if (list) list.push(p);
      else suffix.set(s, [p]);
    }
    const d = posixDir(p);
    const list = dirs.get(d);
    if (list) list.push(p);
    else dirs.set(d, [p]);
  }
  const dirSuffix = new Map<string, string[]>();
  for (const d of dirs.keys()) {
    const segs = d ? d.split('/') : [];
    for (let i = 0; i < segs.length; i++) {
      const sfx = segs.slice(i).join('/');
      const list = dirSuffix.get(sfx);
      if (list) list.push(d);
      else dirSuffix.set(sfx, [d]);
    }
  }
  goMods.sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1));
  return { files, suffix, dirs, dirSuffix, goMods };
}

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function resolveJs(from: string, imp: ImportRef, idx: Index): string[] {
  if (!imp.spec.startsWith('.')) return [];
  const base = normalizeJoin(posixDir(from), imp.spec);
  const cands = [base];
  const stripped = base.replace(/\.(m|c)?jsx?$/, '');
  for (const stem of new Set([base, stripped])) {
    for (const e of JS_EXTS) cands.push(stem + e);
    for (const e of JS_EXTS) cands.push(`${stem}/index${e}`);
  }
  const hit = cands.find((c) => idx.files.has(c) && c !== from);
  return hit ? [hit] : [];
}

function resolvePython(from: string, imp: ImportRef, idx: Index): string[] {
  const dots = /^\.*/.exec(imp.spec)![0].length;
  const mod = imp.spec.slice(dots).replace(/\./g, '/');
  const out: string[] = [];
  const tryMod = (m: string, relDir: string | null) => {
    for (const c of [`${m}.py`, `${m}/__init__.py`]) {
      if (relDir !== null) {
        const p = normalizeJoin(relDir, c);
        if (idx.files.has(p)) return p;
      } else {
        const hits = idx.suffix.get(c);
        if (hits?.length) return [...hits].sort((a, b) => a.length - b.length)[0];
      }
    }
    return null;
  };
  let relDir: string | null = null;
  if (dots) {
    relDir = posixDir(from);
    for (let i = 1; i < dots; i++) relDir = posixDir(relDir);
  }
  const main = mod ? tryMod(mod, relDir) : null;
  if (main && main !== from) out.push(main);
  for (const n of imp.names) {
    const sub = tryMod(mod ? `${mod}/${n}` : n, relDir);
    if (sub && sub !== from && !out.includes(sub)) out.push(sub);
  }
  if (!mod && dots) {
    const init = normalizeJoin(relDir ?? '', '__init__.py');
    if (idx.files.has(init) && init !== from && !out.includes(init)) out.push(init);
  }
  return out;
}

// Go imports resolve only inside the repo: through the go.mod module path when one matches, else (no
// go.mod declared at all) by a directory suffix of at least two segments. Stdlib and external
// imports therefore produce no edge.
function resolveGo(from: string, imp: ImportRef, idx: Index): string[] {
  const goFiles = (dir: string) => (idx.dirs.get(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && f !== from).sort();
  const mod = idx.goMods.find((m) => imp.spec === m.mod || imp.spec.startsWith(m.mod + '/'));
  if (mod) return goFiles(normalizeJoin(mod.dir, imp.spec.slice(mod.mod.length)));
  if (idx.goMods.length) return [];
  const parts = imp.spec.split('/');
  for (let k = parts.length; k >= 2; k--) {
    const files = (idx.dirSuffix.get(parts.slice(parts.length - k).join('/')) ?? []).flatMap(goFiles);
    if (files.length) return files.sort();
  }
  return [];
}

function resolveJava(from: string, imp: ImportRef, idx: Index): string[] {
  const hits = idx.suffix.get(imp.spec.replace(/\./g, '/') + '.java') ?? [];
  return hits.filter((h) => h !== from).sort().slice(0, 1);
}

function resolveRust(from: string, imp: ImportRef, idx: Index): string[] {
  const dir = posixDir(from);
  const stem = baseName(from).replace(/\.rs$/, '');
  if (imp.mod) {
    const base = stem === 'mod' || stem === 'lib' || stem === 'main' ? dir : normalizeJoin(dir, stem);
    for (const c of [normalizeJoin(base, `${imp.spec}.rs`), normalizeJoin(base, `${imp.spec}/mod.rs`)]) if (idx.files.has(c)) return [c];
    return [];
  }
  const segs = imp.spec.split('::').filter((s) => s !== 'crate' && s !== 'self' && s !== 'super');
  for (let k = segs.length; k >= 1; k--) {
    const rel = segs.slice(0, k).join('/');
    for (const c of [`${rel}.rs`, `${rel}/mod.rs`]) {
      const hits = (idx.suffix.get(c) ?? []).filter((h) => h !== from);
      if (hits.length) return [[...hits].sort((a, b) => a.length - b.length)[0]];
    }
  }
  return [];
}

export function resolveImport(from: string, lang: string, imp: ImportRef, idx: Index): string[] {
  if (isJsLike(lang)) return resolveJs(from, imp, idx);
  if (lang === 'python') return resolvePython(from, imp, idx);
  if (lang === 'go') return resolveGo(from, imp, idx);
  if (lang === 'java') return resolveJava(from, imp, idx);
  if (lang === 'rust') return resolveRust(from, imp, idx);
  return [];
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//;

export function isTestPath(path: string): boolean {
  const b = baseName(path);
  return TEST_PATH.test(path) || /\.(test|spec)\.\w+$/.test(b) || /_test\.\w+$/.test(b) || /^test_.*\.py$/.test(b) || /[a-z0-9](Test|Tests|IT)\.java$/.test(b);
}

// "foo.test.ts" / "foo.spec.js" / "test_foo.py" / "foo_test.go" / "FooTest.java" -> "foo" / "Foo".
// A suffix is stripped only when the name matches a real test naming pattern, so "Edit.java" or
// "Credit.ts" keep their names. Null when the file is not named like a test of a single subject.
function testSubject(path: string): string | null {
  const b = baseName(path);
  let m: RegExpExecArray | null;
  if ((m = /^(.+)\.(?:test|spec)\.\w+$/.exec(b))) return m[1];
  if ((m = /^(.+)_test\.\w+$/.exec(b))) return m[1];
  if ((m = /^test_(.+)\.py$/.exec(b))) return m[1];
  if ((m = /^(.+?[a-z0-9])(?:Tests?|IT)\.java$/.exec(b))) return m[1];
  return null;
}

// Where a test's subject may live: the test's own dir, or, when the test sits in a tests/ dir, the
// subtree of that dir's parent. So test/foo.test.ts finds src/foo.ts, pkg/tests/foo.test.ts only
// finds foo under pkg/, and src/a/foo.test.ts only finds src/a/foo.ts.
function testScope(path: string): { dir: string; subtree: boolean } {
  const segs = posixDir(path).split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^(tests?|__tests__|spec)$/.test(segs[i])) return { dir: segs.slice(0, i).join('/'), subtree: true };
  }
  return { dir: segs.join('/'), subtree: false };
}

const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'lib', 'init', '__init__', 'utils', 'helpers']);

// Pure: derives nodes and edges from per-file extractions. Deterministic ordering.
export function buildGraph(files: Record<string, FileEntry>): { nodes: AtlasNode[]; edges: AtlasEdge[] } {
  const paths = Object.keys(files).sort();
  const idx = buildIndex(files, paths);
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (from === to) return;
    const key = `${kind}|${from}|${to}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind });
  };
  const dirId = (d: string) => (d ? `${d}/` : './');

  const dirs = new Set<string>(['']);
  for (const p of paths) for (let d = posixDir(p); d; d = posixDir(d)) dirs.add(d);
  for (const d of [...dirs].sort()) {
    nodes.push({ id: dirId(d), kind: 'dir', path: d, name: d ? baseName(d) : '.' });
    if (d) addEdge(dirId(posixDir(d)), dirId(d), 'contains');
  }
  const symIds = new Map<string, Map<string, string>>(); // path -> symbol name -> id
  for (const p of paths) {
    const f = files[p];
    nodes.push({ id: p, kind: 'file', path: p, name: baseName(p), lang: f.lang });
    addEdge(dirId(posixDir(p)), p, 'contains');
    const names = new Map<string, string>();
    for (const s of f.symbols) {
      let id = `${p}#${s.name}`;
      if (names.has(s.name)) id = `${id}@${s.line}`;
      if (!names.has(s.name)) names.set(s.name, id);
      nodes.push({ id, kind: 'symbol', path: p, name: s.name, symKind: s.kind, line: s.line, exported: s.exported });
      addEdge(p, id, 'contains');
    }
    symIds.set(p, names);
  }

  const bySubject = new Map<string, string[]>();
  for (const p of paths) {
    if (isTestPath(p)) continue;
    const stem = baseName(p).replace(/\.[^.]+$/, '');
    const list = bySubject.get(stem);
    if (list) list.push(p);
    else bySubject.set(stem, [p]);
  }

  for (const p of paths) {
    const f = files[p];
    const test = isTestPath(p);
    for (const imp of f.imports) {
      for (const target of resolveImport(p, f.lang, imp, idx)) {
        addEdge(p, target, 'imports');
        if (test && !isTestPath(target)) addEdge(p, target, 'tests');
        const syms = symIds.get(target);
        for (const n of imp.names) {
          const id = syms?.get(n);
          if (id) addEdge(p, id, 'references');
        }
      }
    }
    if (test) {
      const subject = testSubject(p);
      if (subject && !GENERIC_STEMS.has(subject)) {
        const scope = testScope(p);
        for (const t of bySubject.get(subject) ?? []) {
          const td = posixDir(t);
          const inScope = scope.subtree ? scope.dir === '' || td === scope.dir || td.startsWith(scope.dir + '/') : td === scope.dir;
          if (inScope) addEdge(p, t, 'tests');
        }
      }
    }
  }
  return { nodes, edges };
}

// ---- build, cache, incremental ----

function readEntry(path: string, buf: Buffer | null | undefined): FileEntry | null {
  if (!buf || buf.length > MAX_FILE_BYTES) return null;
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return extractFile(path, buf.toString('utf8'));
}

function assemble(sha: string, files: Record<string, FileEntry>): Atlas {
  const sorted: Record<string, FileEntry> = {};
  for (const p of Object.keys(files).sort()) sorted[p] = files[p];
  return { version: ATLAS_VERSION, sha, files: sorted, ...buildGraph(sorted) };
}

function indexableFiles(root: string, sha: string): string[] {
  return filesAtRef(root, sha).filter((p) => !isExcludedPath(p));
}

function extractMany(root: string, sha: string, paths: string[]): Record<string, FileEntry> {
  const out: Record<string, FileEntry> = {};
  const CHUNK = 2000;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const blobs = readBlobsAtRef(root, sha, paths.slice(i, i + CHUNK).filter((p) => !BINARY_EXT.test(p)), MAX_FILE_BYTES);
    for (const [p, buf] of blobs) {
      const e = readEntry(p, buf);
      if (e) out[p] = e;
    }
  }
  return out;
}

// Full build of the tracked tree at `sha`, or an incremental one when `prev` (a cached atlas for an
// ancestor or sibling commit) is given: only changed and added files are re-extracted.
export function buildAtlas(root: string, sha: string, prev?: Atlas): Atlas {
  const full = git(root, 'rev-parse', sha);
  if (prev && prev.version === ATLAS_VERSION && commitExists(root, prev.sha)) {
    const changed = new Set(diffNamesBetween(root, prev.sha, full));
    const now = new Set(indexableFiles(root, full));
    const files: Record<string, FileEntry> = {};
    for (const [p, e] of Object.entries(prev.files)) if (now.has(p) && !changed.has(p)) files[p] = e;
    const redo = [...now].filter((p) => changed.has(p) || (!files[p] && !(p in prev.files)));
    Object.assign(files, extractMany(root, full, redo));
    return assemble(full, files);
  }
  return assemble(full, extractMany(root, full, indexableFiles(root, full)));
}

function cachedShas(store: Store): string[] {
  const d = store.path('atlas');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^[0-9a-f]{40}\.json$/.test(f))
    .map((f) => f.slice(0, -5));
}

// Cached shas, most recently written first (ties broken by sha for determinism).
function cachedByRecency(store: Store): string[] {
  const mtime = (s: string) => {
    try {
      return statSync(store.path(`atlas/${s}.json`)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return cachedShas(store)
    .map((s) => ({ s, t: mtime(s) }))
    .sort((a, b) => b.t - a.t || (a.s < b.s ? -1 : 1))
    .map((x) => x.s);
}

// Keeps only the `keep` most recent cached atlases, never removing `protect`.
function pruneCache(store: Store, keep: number, protect: string): void {
  for (const s of cachedByRecency(store).filter((x) => x !== protect).slice(Math.max(0, keep - 1))) {
    try {
      unlinkSync(store.path(`atlas/${s}.json`));
    } catch {
      // best effort: a stale cache file is harmless
    }
  }
}

function readCached(store: Store, sha: string): Atlas | null {
  try {
    const a = store.readJson<Atlas | null>(`atlas/${sha}.json`, null);
    return a && a.version === ATLAS_VERSION && a.sha === sha ? a : null;
  } catch {
    return null; // corrupt cache: rebuild
  }
}

// Picks at most MAX_NEAREST_CANDIDATES cached shas without diffing them all: ancestors of `full`
// nearest first (one rev-list), then the most recently written caches for unrelated history.
function nearestCandidates(root: string, store: Store, full: string): string[] {
  const cached = new Set(cachedShas(store));
  cached.delete(full);
  if (!cached.size) return [];
  const picked: string[] = [];
  const log = tryGit(root, 'rev-list', '--max-count=500', full);
  if (log.ok) for (const s of log.out.split('\n')) if (cached.has(s) && picked.length < MAX_NEAREST_CANDIDATES) picked.push(s);
  for (const s of cachedByRecency(store)) {
    if (picked.length >= MAX_NEAREST_CANDIDATES) break;
    if (cached.has(s) && !picked.includes(s) && commitExists(root, s)) picked.push(s);
  }
  return picked;
}

// Exact cache hit, else incremental from the nearby cached commit with the smallest diff, else full.
// The cache is pruned to the MAX_CACHED_ATLASES most recent files.
export function loadOrBuildAtlas(root: string, sha: string): Atlas {
  const store = new Store(root);
  const full = git(root, 'rev-parse', sha);
  const hit = readCached(store, full);
  if (hit) return hit;
  let best: { atlas: Atlas; n: number } | null = null;
  for (const s of nearestCandidates(root, store, full)) {
    const atlas = readCached(store, s);
    if (!atlas) continue;
    const n = diffNamesBetween(root, s, full).length;
    if (!best || n < best.n) best = { atlas, n };
  }
  const built = buildAtlas(root, full, best?.atlas);
  store.writeText(`atlas/${full}.json`, JSON.stringify(built) + '\n');
  pruneCache(store, MAX_CACHED_ATLASES, full);
  return built;
}

export function atlasStats(atlas: Atlas): AtlasStats {
  const edges: Record<EdgeKind, number> = { contains: 0, imports: 0, references: 0, tests: 0 };
  for (const e of atlas.edges) edges[e.kind]++;
  const languages: Record<string, number> = {};
  for (const f of Object.values(atlas.files)) languages[f.lang] = (languages[f.lang] ?? 0) + 1;
  let dirs = 0;
  let symbols = 0;
  for (const n of atlas.nodes) {
    if (n.kind === 'dir') dirs++;
    else if (n.kind === 'symbol') symbols++;
  }
  return { files: Object.keys(atlas.files).length, dirs, symbols, edges, languages };
}
