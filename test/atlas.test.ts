import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { atlasStats, buildAtlas, extractFile, extractGo, extractJava, extractPython, extractRust, extractTsJs, isExcludedPath, loadOrBuildAtlas } from '../src/atlas.ts';
import { readBlobsAtRef } from '../src/git.ts';
import { EVOLVABLE_FILES } from '../src/harness.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';
import { tempRepo } from './helpers.ts';

const names = (e: { symbols: { name: string; kind: string }[] }) => e.symbols.map((s) => `${s.kind}:${s.name}`);

test('extractTsJs finds symbols and imports', () => {
  const src = `import { a, b as c } from './foo.ts';
import def, * as ns from "./bar";
import type { T } from './types.ts';
import './side.ts';
export * from './reexp.ts';
const x = require('./cjs.js');
export function run(a: number) {}
export async function go() {}
export class Svc extends Base {
  constructor(private x: number) {}
  public async load(id: string): Promise<void> {
    if (id) {
    }
  }
}
function local() {}
export interface Opts { a: 1 }
export type Id = string;
export const LIMIT = 3;
`;
  const e = extractTsJs(src);
  assert.deepEqual(names(e), ['function:run', 'function:go', 'class:Svc', 'method:Svc.constructor', 'method:Svc.load', 'function:local', 'type:Opts', 'type:Id', 'const:LIMIT']);
  assert.equal(e.symbols.find((s) => s.name === 'local')!.exported, false);
  assert.equal(e.symbols.find((s) => s.name === 'run')!.exported, true);
  const specs = e.imports.map((i) => i.spec);
  for (const s of ['./foo.ts', './bar', './types.ts', './side.ts', './reexp.ts', './cjs.js']) assert.ok(specs.includes(s), s);
  assert.deepEqual(e.imports.find((i) => i.spec === './foo.ts')!.names, ['a', 'b']);
});

test('extractPython', () => {
  const src = `import os, sys as s
from .util import helper, Other as O
from pkg.mod import (
    one,
    two,
)
MAX_N = 3

class Foo:
    def method(self):
        def inner(): pass
    async def amethod(self): pass

def top(): pass
`;
  const e = extractPython(src);
  assert.deepEqual(names(e), ['const:MAX_N', 'class:Foo', 'method:Foo.method', 'method:Foo.amethod', 'function:top']);
  assert.deepEqual(e.imports.find((i) => i.spec === '.util')!.names, ['helper', 'Other']);
  assert.deepEqual(e.imports.find((i) => i.spec === 'pkg.mod')!.names, ['one', 'two']);
  assert.ok(e.imports.some((i) => i.spec === 'os'));
});

test('extractGo', () => {
  const src = `package x
import "fmt"
import (
	"github.com/acme/app/internal/util"
	alias "strings"
)
type Server struct{}
type Handler interface{}
func New() *Server { return nil }
func (s *Server) Start() error { return nil }
func helper() {}
const Max = 3
`;
  const e = extractGo(src);
  assert.deepEqual(names(e), ['class:Server', 'type:Handler', 'function:New', 'method:Server.Start', 'function:helper', 'const:Max']);
  assert.equal(e.symbols.find((s) => s.name === 'helper')!.exported, false);
  assert.deepEqual(e.imports.map((i) => i.spec).sort(), ['fmt', 'github.com/acme/app/internal/util', 'strings']);
});

test('extractJava', () => {
  const src = `package com.acme;
import com.acme.util.Strings;
import static com.acme.util.Math.max;
import java.util.*;
public class Service {
    private int n;
    public Service(int n) { this.n = n; }
    public static List<String> names(int a) throws Exception {
        return foo(a);
    }
    void run() {
        if (n > 0) {
        }
    }
}
interface Thing {}
`;
  const e = extractJava(src);
  assert.deepEqual(names(e), ['class:Service', 'method:Service.names', 'method:Service.run', 'class:Thing']);
  assert.deepEqual(e.imports, [{ spec: 'com.acme.util.Strings', names: ['Strings'] }, { spec: 'com.acme.util.Math', names: ['max'] }]);
});

test('extractRust', () => {
  const src = `use crate::util::{helper, Other};
use std::fmt;
mod parser;
pub struct Config { a: i32 }
pub enum Kind { A }
pub trait Run {}
pub const LIMIT: usize = 3;
pub fn build() {}
impl Config {
    pub fn new() -> Self { Config { a: 1 } }
}
`;
  const e = extractRust(src);
  assert.deepEqual(names(e), ['class:Config', 'type:Kind', 'type:Run', 'const:LIMIT', 'function:build', 'method:new']);
  assert.deepEqual(e.imports.map((i) => i.spec), ['crate::util::helper', 'crate::util::Other', 'std::fmt', 'parser']);
  assert.equal(e.imports[3].mod, true);
});

test('file-level fallback for other text files', () => {
  const e = extractFile('docs/notes.md', '# hi\ntext\n');
  assert.equal(e.lang, 'text');
  assert.deepEqual(e.symbols, []);
  assert.deepEqual(e.imports, []);
  assert.equal(e.lines, 2);
  assert.equal(extractFile('a.ts', 'export const A = 1;\n').lang, 'ts');
});

test('isExcludedPath covers state dir, .env* and secrets', () => {
  for (const p of ['.orchestra/x/a.json', 'pkg/.orchestra/x.ts', '.env', '.env.local', '.envrc', 'a/.env.prod', 'id_rsa', 'k/server.pem', 'x/id_ed25519', '.npmrc']) assert.ok(isExcludedPath(p), p);
  for (const p of ['src/a.ts', 'environment.ts', 'docs/env.md']) assert.ok(!isExcludedPath(p), p);
});

function commit(dir: string, msg: string): string {
  execFileSync('git', ['add', '-A', '-f'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}
function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

test('atlas never indexes state dir, .env* or secret files (regression)', () => {
  const store = tempRepo();
  const dir = store.root;
  put(dir, 'src/ok.ts', 'export const OK = 1;\n');
  put(dir, '.orchestra/hidden/scenario.json', '{"secret":"STATE_MARKER"}');
  put(dir, '.orchestra/atlas/old.json', 'ATLAS_MARKER');
  put(dir, '.env', 'TOKEN=ENV_MARKER');
  put(dir, '.env.local', 'TOKEN=ENVLOCAL_MARKER');
  put(dir, 'id_rsa', 'KEY_MARKER');
  put(dir, 'certs/server.pem', 'PEM_MARKER');
  const sha = commit(dir, 'add');
  const atlas = loadOrBuildAtlas(dir, sha);
  const json = readFileSync(join(dir, '.orchestra', 'atlas', `${sha}.json`), 'utf8');
  for (const bad of ['.orchestra', '.env', 'id_rsa', 'server.pem', 'MARKER', 'scenario.json']) assert.ok(!json.includes(bad), bad);
  assert.deepEqual(Object.keys(atlas.files).sort(), ['README.md', 'src/ok.ts']);
});

test('atlas resolves relative imports, tests edges, and caches by sha', () => {
  const store = tempRepo();
  const dir = store.root;
  put(dir, 'src/foo.ts', 'export function foo() {}\nexport const K = 1;\n');
  put(dir, 'src/bar.ts', "import { foo } from './foo.ts';\nimport { K } from './foo.js';\nexport const bar = () => foo();\n");
  put(dir, 'test/foo.test.ts', "import { foo } from '../src/foo.ts';\n");
  put(dir, 'test/bar.test.ts', '// names bar\nexport {};\n');
  const sha = commit(dir, 'a');
  const a = loadOrBuildAtlas(dir, sha);
  const has = (from: string, to: string, kind: string) => a.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  assert.ok(has('src/bar.ts', 'src/foo.ts', 'imports'));
  assert.ok(has('src/bar.ts', 'src/foo.ts#foo', 'references'));
  assert.ok(has('src/bar.ts', 'src/foo.ts#K', 'references'));
  assert.ok(has('test/foo.test.ts', 'src/foo.ts', 'tests'));
  assert.ok(has('test/bar.test.ts', 'src/bar.ts', 'tests'), 'name-based tests edge');
  assert.ok(has('src/', 'src/foo.ts', 'contains'));
  assert.ok(has('src/foo.ts', 'src/foo.ts#foo', 'contains'));
  assert.deepEqual(loadOrBuildAtlas(dir, sha), a);
  const st = atlasStats(a);
  assert.equal(st.files, 5);
  assert.equal(st.languages.ts, 4);
  assert.deepEqual([st.edges.tests, st.edges.imports, st.symbols], [2, 2, 3]);
});

test('a second call for the same sha reads the cache file', () => {
  const store = tempRepo();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: store.root, encoding: 'utf8' }).trim();
  const first = loadOrBuildAtlas(store.root, sha);
  const cached = JSON.parse(readFileSync(join(store.root, '.orchestra/atlas', `${sha}.json`), 'utf8'));
  cached.marker = 'from-cache';
  writeFileSync(join(store.root, '.orchestra/atlas', `${sha}.json`), JSON.stringify(cached));
  assert.equal((loadOrBuildAtlas(store.root, sha) as unknown as { marker: string }).marker, 'from-cache');
  assert.equal(first.sha, sha);
});

test('incremental build equals a full build after edit, add and delete', () => {
  const store = tempRepo();
  const dir = store.root;
  put(dir, 'src/a.ts', 'export function a() {}\n');
  put(dir, 'src/b.ts', "import { a } from './a.ts';\nexport const b = a;\n");
  put(dir, 'src/gone.ts', 'export const g = 1;\n');
  const sha1 = commit(dir, 'one');
  loadOrBuildAtlas(dir, sha1);
  put(dir, 'src/a.ts', 'export function a() {}\nexport function a2() {}\n');
  rmSync(join(dir, 'src/gone.ts'));
  put(dir, 'src/new.ts', "import { b } from './b.ts';\n");
  const sha2 = commit(dir, 'two');
  const inc = loadOrBuildAtlas(dir, sha2);
  const full = buildAtlas(dir, sha2);
  assert.deepEqual(inc, full);
  assert.ok(!('src/gone.ts' in inc.files));
  assert.ok(inc.files['src/a.ts'].symbols.some((s) => s.name === 'a2'));
  assert.ok(readFileSync(join(dir, '.orchestra/atlas', `${sha2}.json`), 'utf8').length > 0);
});

test('context.atlas config defaults and deep merge; EVOLVABLE_FILES untouched', () => {
  const store = tempRepo();
  assert.deepEqual(store.config().context.atlas, { enabled: false, mapTokens: 1024, packs: false, packTokens: 1500 });
  store.writeJson('config.json', { ...DEFAULT_PROJECT_CONFIG, context: { atlas: { enabled: true } } });
  assert.deepEqual(store.config().context.atlas, { enabled: true, mapTokens: 1024, packs: false, packTokens: 1500 });
  store.writeJson('config.json', { testCommand: 'x' });
  assert.equal(store.config().context.atlas.enabled, false);
  assert.ok(!JSON.stringify(EVOLVABLE_FILES).includes('atlas'));
});

test('readBlobsAtRef skips oversized blobs without loading them, and the atlas skips binary extensions', () => {
  const store = tempRepo();
  const dir = store.root;
  put(dir, 'small.ts', 'export const S = 1;\n');
  put(dir, 'big.ts', 'x'.repeat(5000));
  put(dir, 'logo.png', 'not really a png');
  const sha = commit(dir, 'blobs');
  const got = readBlobsAtRef(dir, sha, ['small.ts', 'big.ts', 'missing.ts'], 1000);
  assert.equal(got.get('small.ts')?.toString(), 'export const S = 1;\n');
  assert.equal(got.get('big.ts'), null);
  assert.equal(got.get('missing.ts'), null);
  const atlas = buildAtlas(dir, sha);
  assert.ok('small.ts' in atlas.files);
  assert.ok(!('logo.png' in atlas.files));
});

test('loadOrBuildAtlas diffs only a few ancestor candidates and prunes the cache', () => {
  const store = tempRepo();
  const dir = store.root;
  const shas: string[] = [];
  for (let i = 0; i < 20; i++) {
    put(dir, `src/f${i}.ts`, `export const F${i} = ${i};\n`);
    shas.push(commit(dir, `c${i}`));
    loadOrBuildAtlas(dir, shas[i]);
  }
  const cached = readdirSync(join(dir, '.orchestra/atlas')).filter((f) => f.endsWith('.json'));
  assert.equal(cached.length, 16);
  assert.ok(cached.includes(`${shas[19]}.json`), 'newest atlas kept');
  const inc = loadOrBuildAtlas(dir, shas[19]);
  assert.deepEqual(inc, buildAtlas(dir, shas[19]));
});

test('extractTsJs keeps imports separate in semicolon-less code', () => {
  const ex = extractTsJs("export const A = 1\nimport b from './b'\nexport { c } from './c'\nimport d from \"./d\"\nexport * from './e'\n");
  assert.deepEqual(ex.imports.map((i) => [i.spec, i.names.join(',')]), [['./b', 'default'], ['./c', 'c'], ['./d', 'default'], ['./e', '']]);
});

test('Go imports resolve by module path, not by last segment (no stdlib or external edges)', () => {
  const store = tempRepo();
  const dir = store.root;
  put(dir, 'go.mod', 'module example.com/acme/app\n\ngo 1.22\n');
  put(dir, 'cmd/main.go', 'package main\nimport (\n  "fmt"\n  "net/http"\n  "github.com/other/http"\n  "example.com/acme/app/internal/http"\n  "example.com/acme/app/pkg/util"\n)\nfunc main() {}\n');
  put(dir, 'internal/http/server.go', 'package http\nfunc Serve() {}\n');
  put(dir, 'pkg/util/util.go', 'package util\nfunc U() {}\n');
  put(dir, 'vendor/fmt/fmt.go', 'package fmt\n');
  const a = buildAtlas(dir, commit(dir, 'go'));
  const targets = a.edges.filter((e) => e.kind === 'imports' && e.from === 'cmd/main.go').map((e) => e.to).sort();
  assert.deepEqual(targets, ['internal/http/server.go', 'pkg/util/util.go']);
});

test('Go imports without a go.mod need two trailing segments to match a directory', () => {
  const store = tempRepo();
  const dir = store.root;
  put(dir, 'a/main.go', 'package main\nimport (\n  "fmt"\n  "lib/util"\n  "x/y/svc/store"\n)\n');
  put(dir, 'fmt/fmt.go', 'package fmt\n');
  put(dir, 'util/util.go', 'package util\n');
  put(dir, 'svc/store/store.go', 'package store\n');
  const a = buildAtlas(dir, commit(dir, 'go2'));
  const targets = a.edges.filter((e) => e.kind === 'imports' && e.from === 'a/main.go').map((e) => e.to);
  assert.deepEqual(targets, ['svc/store/store.go']);
});
