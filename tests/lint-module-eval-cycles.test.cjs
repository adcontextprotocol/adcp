#!/usr/bin/env node
/**
 * Tests for `scripts/lint-module-eval-cycles.cjs`.
 *
 *   1. Source-tree guard: with every server/src module taken as the first
 *      entry, no module uses, at evaluation time, a binding from a module that
 *      is still evaluating.
 *   2. Rule coverage on inline module graphs: a direct const read, an
 *      evaluation-time call, a read through a re-export chain, the other
 *      evaluation-time positions, and the negative cases (a function
 *      reference only, a read inside a function body, an entry order that
 *      finishes the definer first, a cycle that exists only in types).
 *   3. Type-elision parity: which imports survive as runtime dependencies,
 *      per import form.
 *   4. The module record cache (openCache): a fresh process reuses records
 *      whose inputs are unchanged and re-analyses exactly the ones whose
 *      source, resolutions or cache version changed, with violations identical
 *      to an uncached run; plus a negative control over the real tree.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAnalyzer, formatViolation, holeKey, lint, openCache, scan, scopeFiles } = require('../scripts/lint-module-eval-cycles.cjs');

const ROOT = path.resolve(__dirname, '..');

/** Violations for an in-memory module graph { path: source }, entered at `entries` (default: every module). */
function holes(files, entries = Object.keys(files)) {
  return scan({ entries, read: (f) => files[f] }).map(holeKey);
}

// a.ts imports b.ts (so entering at a.ts evaluates b.ts while a.ts is in
// progress); b.ts imports back from a.ts. `bBody` is b.ts after its imports.
function cycle(bImports, bBody, aExtra = '') {
  return {
    'src/a.ts': [
      "import { useB } from './b.js';",
      "export const SCHEMA = { type: 'object' };",
      'export function helper() { return SCHEMA; }',
      'export class Base {}',
      aExtra,
      'export function touch() { return useB; }',
    ].join('\n'),
    'src/b.ts': [bImports, bBody, 'export function useB() { return 1; }'].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Tree check
// ---------------------------------------------------------------------------

test('tree: no server/src module uses a binding from a module still evaluating, under any first entry', () => {
  const violations = lint();
  assert.deepEqual(violations.map(holeKey), [],
    `Expected zero violations, got ${violations.length}:\n${violations.map(formatViolation).join('\n')}`);
});

test('tree: the scan covers all of server/src, not one directory, and skips tests', () => {
  const files = scopeFiles();
  assert.ok(files.length > 900, `expected the whole of server/src, got ${files.length} modules`);
  assert.ok(files.includes('server/src/index.ts'));
  assert.ok(files.includes('server/src/training-agent/index.ts'));
  assert.ok(files.includes('server/src/middleware/pg-rate-limit-store.ts'));
  assert.ok(!files.some((f) => /\.test\.ts$|\.d\.ts$/.test(f)));
});

test('tree: entering at the production entry points finds nothing', () => {
  assert.deepEqual(lint({ entries: ['server/src/index.ts'] }).map(holeKey), []);
  assert.deepEqual(lint({ entries: ['server/src/training-agent/index.ts'] }).map(holeKey), []);
});

// ---------------------------------------------------------------------------
// Meta-tests: positive forms
// ---------------------------------------------------------------------------

test('flags a direct const read from a module still evaluating, only for the entry that causes it', () => {
  const files = cycle("import { SCHEMA } from './a.js';", 'export const TOOLS = [{ name: "t", inputSchema: SCHEMA }];');
  assert.deepEqual(holes(files, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  assert.deepEqual(holes(files, ['src/b.ts']), [], 'entered at b.ts, a.ts finishes before b.ts reads it');
  const [hole] = scan({ entries: Object.keys(files), read: (f) => files[f] });
  assert.deepEqual(hole.entries, ['src/a.ts']);
  assert.equal(hole.useLine, 2);
});

test('flags let, class and enum reads and export default <expression>', () => {
  const extra = "export let counter = 0;\nexport enum Kind { A = 'a' }\nexport default { kind: 'x' };";
  const files = cycle(
    "import defaultConfig, { Base, counter, Kind } from './a.js';",
    'export class Child extends Base {}\nexport const C = counter;\nexport const K = Kind.A;\nexport const D = defaultConfig;',
    extra,
  );
  assert.deepEqual(holes(files, ['src/a.ts']), [
    'src/b.ts:1 reads Base from in-progress src/a.ts',
    'src/b.ts:1 reads counter from in-progress src/a.ts',
    'src/b.ts:1 reads default from in-progress src/a.ts',
    'src/b.ts:1 reads Kind from in-progress src/a.ts',
  ]);
});

test('flags an evaluation-time call of an imported function declaration from a module still evaluating', () => {
  // helper() is a hoisted function declaration, but calling it reads SCHEMA before a.ts initialised it.
  const files = cycle("import { helper } from './a.js';", 'export const FALLBACK = helper();');
  assert.deepEqual(holes(files, ['src/a.ts']), ['src/b.ts:1 calls helper from in-progress src/a.ts']);
});

test('flags evaluation-time calls through new, tagged templates, a top-level IIFE and a local function called at top level', () => {
  const viaNew = cycle("import { Base } from './a.js';", 'export const instance = new Base();');
  assert.deepEqual(holes(viaNew, ['src/a.ts']), ['src/b.ts:1 calls Base from in-progress src/a.ts']);
  const viaTag = cycle("import { helper } from './a.js';", 'export const QUERY = helper`select 1`;');
  assert.deepEqual(holes(viaTag, ['src/a.ts']), ['src/b.ts:1 calls helper from in-progress src/a.ts']);
  const viaIife = cycle("import { SCHEMA } from './a.js';", 'export const TOOLS = (() => [SCHEMA])();');
  assert.deepEqual(holes(viaIife, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  const viaLocal = cycle("import { SCHEMA } from './a.js';", 'function build() { return [SCHEMA]; }\nexport const TOOLS = build();');
  assert.deepEqual(holes(viaLocal, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  const viaLocalArrow = cycle("import { helper } from './a.js';", 'const build = () => helper();\nexport const TOOLS = build();');
  assert.deepEqual(holes(viaLocalArrow, ['src/a.ts']), ['src/b.ts:1 calls helper from in-progress src/a.ts']);
});

test('flags a read through a barrel re-export whose defining module is still evaluating', () => {
  // b.ts reads SCHEMA from barrel.ts, which is done; barrel.ts re-exports it from a.ts, which is in progress.
  const named = {
    ...cycle("import { SCHEMA } from './barrel.js';", 'export const TOOLS = [SCHEMA];'),
    'src/barrel.ts': "export { SCHEMA } from './a.js';\n",
  };
  assert.deepEqual(holes(named, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  const star = {
    ...cycle("import { SCHEMA as S } from './barrel.js';", 'export const TOOLS = [S];'),
    'src/barrel.ts': "export * from './other.js';\nexport * from './a.js';\n",
    'src/other.ts': 'export const UNRELATED = 1;\n',
  };
  assert.deepEqual(holes(star, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  const importedThenExported = {
    ...cycle("import { SCHEMA } from './barrel.js';", 'export const TOOLS = [SCHEMA];'),
    'src/barrel.ts': "import { SCHEMA } from './a.js';\nexport { SCHEMA };\n",
  };
  assert.deepEqual(holes(importedThenExported, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  const [hole] = scan({ entries: ['src/a.ts'], read: (f) => named[f] });
  assert.deepEqual(hole.via, ['src/barrel.ts']);
});

test('flags a member read on a namespace import and the other evaluation-time positions of a class', () => {
  const ns = cycle("import * as a from './a.js';", 'export const TOOLS = [a.SCHEMA];\nexport const fnRef = a.helper;');
  assert.deepEqual(holes(ns, ['src/a.ts']), ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts']);
  const statics = cycle(
    "import { SCHEMA, helper } from './a.js';",
    'export class Registry {\n  static schema = SCHEMA;\n  static { helper(); }\n  instanceField = SCHEMA;\n  method() { return helper(); }\n}',
  );
  assert.deepEqual(holes(statics, ['src/a.ts']), [
    'src/b.ts:1 calls helper from in-progress src/a.ts',
    'src/b.ts:1 reads SCHEMA from in-progress src/a.ts',
  ]);
});

// ---------------------------------------------------------------------------
// Meta-tests: negative forms
// ---------------------------------------------------------------------------

test('passes a reference to an imported function declaration that is not called', () => {
  const files = cycle("import { helper } from './a.js';", 'export const HANDLERS = { helper, alias: helper };');
  assert.deepEqual(holes(files), []);
});

test('passes reads and calls inside function bodies, methods, arrow bodies and default parameters', () => {
  const files = cycle(
    "import { SCHEMA, helper, Base } from './a.js';",
    [
      'export function tools() { return [SCHEMA, helper()]; }',
      'export const lazy = () => SCHEMA;',
      'export const withDefault = (s = SCHEMA) => s;',
      'export const obj = { get schema() { return SCHEMA; }, make() { return new Base(); } };',
    ].join('\n'),
  );
  assert.deepEqual(holes(files), []);
});

test('passes a cycle whose back edge is type-only or elided', () => {
  const typeOnly = cycle("import type { Base } from './a.js';", 'export const TOOLS: Base[] = [];');
  assert.deepEqual(holes(typeOnly), []);
  const typePosition = cycle("import { SCHEMA } from './a.js';", 'export const TOOLS: Array<typeof SCHEMA> = [];');
  assert.deepEqual(holes(typePosition), [], 'an import used only in types is elided, so b.ts does not import a.ts at runtime');
});

test('passes a function reference through a barrel that has already finished, but not through one still evaluating', () => {
  const files = {
    ...cycle("import { helper } from './barrel.js';", 'export const HANDLERS = [helper];'),
    'src/barrel.ts': "export { helper } from './a.js';\n",
  };
  // Entered at a.ts: barrel.ts has finished, only the defining module a.ts is in progress.
  assert.deepEqual(holes(files, ['src/a.ts', 'src/b.ts']), []);
  // Entered at barrel.ts: the barrel's own import of a.ts has not returned, so its re-export is not bound yet.
  assert.deepEqual(holes(files, ['src/barrel.ts']), ['src/b.ts:1 reads helper from in-progress src/a.ts']);
  const [hole] = scan({ entries: ['src/barrel.ts'], read: (f) => files[f] });
  assert.deepEqual(hole.pending, ['src/barrel.ts', 'src/a.ts']);
});

test('passes a module graph with no cycle, and dynamic imports', () => {
  const files = {
    'src/leaf.ts': "export const SCHEMA = { type: 'object' };\n",
    'src/a.ts': "import { SCHEMA } from './leaf.js';\nimport { TOOLS } from './b.js';\nexport const ALL = [SCHEMA, ...TOOLS];\n",
    'src/b.ts': "import { SCHEMA } from './leaf.js';\nexport const TOOLS = [SCHEMA];\nexport async function late() { return (await import('./a.js')).ALL; }\n",
  };
  assert.deepEqual(holes(files), []);
});

test('the analyser keeps runtime imports in source order and drops the ones type elision removes', () => {
  const files = {
    'src/a.ts': [
      "import './side.js';",
      "import { T } from './types.js';",
      "export { r } from './re.js';",
      "import { type U, v } from './val.js';",
      "export type { W } from './type-reexport.js';",
      "export * from './star.js';",
      'export const x: T = v as U;',
    ].join('\n'),
    'src/side.ts': '', 'src/types.ts': 'export type T = number;', 'src/re.ts': 'export const r = 1;',
    'src/val.ts': 'export type U = number;\nexport const v = 1;', 'src/type-reexport.ts': 'export type W = 1;',
    'src/star.ts': 'export const s = 1;',
  };
  assert.deepEqual(createAnalyzer((f) => files[f]).analyzeModule('src/a.ts').deps, ['src/side.ts', 'src/re.ts', 'src/val.ts', 'src/star.ts']);
});

test('scans that share a reader analyse each module once', () => {
  const files = cycle("import { SCHEMA } from './a.js';", 'export const TOOLS = [SCHEMA];');
  let reads = 0;
  const read = (f) => { reads += 1; return files[f]; };
  const first = scan({ entries: ['src/a.ts'], read }).map(holeKey);
  const afterFirst = reads;
  assert.ok(afterFirst > 0);
  assert.deepEqual(scan({ entries: ['src/a.ts', 'src/b.ts'], read }).map(holeKey), first);
  assert.equal(reads, afterFirst, 'the second scan re-read (and re-parsed) modules the first scan analysed');
});

test('the analyser resolves .js specifiers to .ts sources and directory imports to index.ts', () => {
  const files = {
    'src/a.ts': "import { x } from './dir/index.js';\nimport { y } from './dir';\nexport const z = [x, y];\n",
    'src/dir/index.ts': 'export const x = 1;\nexport const y = 2;\n',
  };
  const analyzer = createAnalyzer((f) => files[f]);
  assert.deepEqual(analyzer.analyzeModule('src/a.ts').deps, ['src/dir/index.ts']);
  assert.deepEqual(analyzer.resolveBinding('src/dir/index.ts', 'x'), { definer: 'src/dir/index.ts', kind: 'value', chain: ['src/dir/index.ts'] });
});

// ---------------------------------------------------------------------------
// Type-elision parity: runtime dependencies per import form
// ---------------------------------------------------------------------------

test('the analyser keeps exactly the imports that survive type elision, for every import form', () => {
  const cases = {
    'type-only import': "import type { T } from './t.js';\nexport const v: T = 1 as T;",
    'type-only specifier': "import { type T } from './t.js';\nexport const v: T = 1 as T;",
    'unused import': "import { u } from './u.js';\nexport const v = 1;",
    'import used only in a type': "import { u } from './u.js';\nexport const v: typeof u = 1;",
    'export-from': "export { r } from './r.js';",
    'type-only export-from': "export type { r } from './r.js';",
    'side-effect import': "import './s.js';",
    'namespace import, used': "import * as ns from './n.js';\nexport const v = ns.x;",
    'namespace import, unused': "import * as ns from './n.js';\nexport const v = 1;",
    'default import': "import d from './d.js';\nexport const v = d;",
    'JSX element': ["import { Comp } from './c.js';\nexport const el = <Comp />;", 'src/m.tsx'],
    'enum member read': "import { Kind } from './k.js';\nexport const v = Kind.A;",
    'local export { X }': "import { X } from './x.js';\nexport { X };",
    'export default X': "import { X } from './x.js';\nexport default X;",
    'class decorator': "import { dec } from './dec.js';\n@dec\nexport class C {}",
    'member decorator': "import { dec } from './dec.js';\nexport class C { @dec method() {} }",
  };
  const expected = {
    'type-only import': [],
    'type-only specifier': [],
    'unused import': [],
    'import used only in a type': [],
    'export-from': ['src/r.ts'],
    'type-only export-from': [],
    'side-effect import': ['src/s.ts'],
    'namespace import, used': ['src/n.ts'],
    'namespace import, unused': [],
    'default import': ['src/d.ts'],
    'JSX element': ['src/c.ts'],
    'enum member read': ['src/k.ts'],
    'local export { X }': ['src/x.ts'],
    'export default X': ['src/x.ts'],
    'class decorator': ['src/dec.ts'],
    'member decorator': ['src/dec.ts'],
  };
  const actual = {};
  for (const [name, spec] of Object.entries(cases)) {
    const [source, file] = Array.isArray(spec) ? spec : [spec, 'src/m.ts'];
    const files = { [file]: source };
    for (const target of ['t', 'u', 'r', 's', 'n', 'd', 'c', 'k', 'x', 'dec']) files[`src/${target}.ts`] = 'export const placeholder = 1;\n';
    actual[name] = createAnalyzer((f) => files[f]).analyzeModule(file).deps;
  }
  assert.deepEqual(actual, expected);
});

// ---------------------------------------------------------------------------
// Module record cache
// ---------------------------------------------------------------------------

/** Runs `fn(dir)` with a fresh temp directory for a cache file, removed afterwards. */
function withCacheDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-lint-cycles-cache-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Opens the disk store; a missing export fails as an assertion, not a TypeError. */
function openStore(file, version = 'test-version-1') {
  assert.equal(typeof openCache, 'function', 'scripts/lint-module-eval-cycles.cjs must export openCache({ file, version })');
  return openCache({ file, version });
}

/**
 * One simulated process: a new reader over `files` (so a new analyser, since
 * analysers are kept per reader) evaluated at every entry, with `store` as its
 * record cache (none when omitted). Returns the sorted distinct violations and
 * the analyser's work counts.
 */
function runProcess(files, store, entries = Object.keys(files)) {
  const read = (f) => files[f];
  const analyzer = store ? createAnalyzer(read, { cache: store }) : createAnalyzer(read);
  const found = new Set();
  for (const entry of entries) for (const hole of analyzer.evaluate(entry)) found.add(holeKey(hole));
  assert.ok(analyzer.stats, 'createAnalyzer must return stats { analysed, reused }');
  return { holes: [...found].sort(), analysed: analyzer.stats.analysed, reused: analyzer.stats.reused };
}

/** Four modules: the a.ts/b.ts cycle (b.ts body as given) plus a leaf c.ts and d.ts, which imports it. */
function cachedTree(bImports = "import { SCHEMA } from './a.js';", bBody = 'export const TOOLS = [SCHEMA];', leaf = 'export const LEAF = 1;\n') {
  return {
    ...cycle(bImports, bBody),
    'src/c.ts': leaf,
    'src/d.ts': "import { LEAF } from './c.js';\nexport const USES_LEAF = [LEAF];\n",
  };
}
const CACHED_TREE_HOLES = ['src/b.ts:1 reads SCHEMA from in-progress src/a.ts'];

test('cache: a fresh analyser over an unchanged tree reuses every saved record, analyses nothing and finds the same violations', () => {
  withCacheDir((dir) => {
    const file = path.join(dir, 'module-eval-cycles.json');
    const files = cachedTree();
    const uncached = runProcess(files);
    const coldStore = openStore(file);
    const cold = runProcess(files, coldStore);
    coldStore.save();
    const warm = runProcess(files, openStore(file));
    assert.deepEqual({ uncached, cold, warm }, {
      uncached: { holes: CACHED_TREE_HOLES, analysed: 4, reused: 0 },
      cold: { holes: CACHED_TREE_HOLES, analysed: 4, reused: 0 },
      warm: { holes: CACHED_TREE_HOLES, analysed: 0, reused: 4 },
    });
  });
});

test('cache: an edited module is re-analysed alone and its new violation replaces the old one', () => {
  withCacheDir((dir) => {
    const file = path.join(dir, 'module-eval-cycles.json');
    const store = openStore(file);
    runProcess(cachedTree(), store);
    store.save();
    const edited = cachedTree("import { helper } from './a.js';", 'export const FALLBACK = helper();');
    const warm = runProcess(edited, openStore(file));
    assert.deepEqual(warm, { holes: ['src/b.ts:1 calls helper from in-progress src/a.ts'], analysed: 1, reused: 3 });
    assert.deepEqual(warm.holes, runProcess(edited).holes, 'cached and uncached runs must agree');
  });
});

test('cache: a new file that changes an unchanged importer\'s resolution re-analyses the importer and the new violation appears', () => {
  withCacheDir((dir) => {
    const file = path.join(dir, 'module-eval-cycles.json');
    // a.ts never changes. './dir' resolves to dir/index.ts until dir.ts exists
    // (dir.ts is tried before dir/index.ts); './later.js' resolves to nothing
    // until later.ts exists.
    const base = {
      'src/a.ts': "import { x } from './dir';\nimport { y } from './later.js';\nexport const SCHEMA = { type: 'object' };\nexport const ALL = [x, y];\n",
      'src/dir/index.ts': 'export const x = 1;\n',
    };
    const first = openStore(file);
    assert.deepEqual(runProcess(base, first), { holes: [], analysed: 2, reused: 0 });
    first.save();

    const withDirFile = { ...base, 'src/dir.ts': "import { SCHEMA } from './a.js';\nexport const x = [SCHEMA];\n" };
    const second = openStore(file);
    const afterDirFile = runProcess(withDirFile, second);
    second.save();
    assert.ok(afterDirFile.holes.includes('src/dir.ts:1 reads SCHEMA from in-progress src/a.ts'), JSON.stringify(afterDirFile.holes));
    assert.deepEqual(afterDirFile, { ...runProcess(withDirFile), analysed: 2, reused: 1 },
      'a.ts (its target changed) and the new dir.ts are analysed; dir/index.ts is reused');

    const withLater = { ...withDirFile, 'src/later.ts': "import { SCHEMA } from './a.js';\nexport const y = SCHEMA;\n" };
    const afterLater = runProcess(withLater, openStore(file));
    assert.ok(afterLater.holes.includes('src/later.ts:1 reads SCHEMA from in-progress src/a.ts'), JSON.stringify(afterLater.holes));
    assert.deepEqual(afterLater, { ...runProcess(withLater), analysed: 2, reused: 2 },
      'a.ts (an unresolved specifier now resolves) and the new later.ts are analysed; dir.ts and dir/index.ts are reused');
  });
});

test('cache: a store opened with a different version ignores the saved records', () => {
  withCacheDir((dir) => {
    const file = path.join(dir, 'module-eval-cycles.json');
    const files = cachedTree();
    const v1 = openStore(file, 'version-1');
    runProcess(files, v1);
    v1.save();
    assert.deepEqual(runProcess(files, openStore(file, 'version-2')), { holes: CACHED_TREE_HOLES, analysed: 4, reused: 0 });
  });
});

test('cache: saving after a scan of a subset of entries keeps the records of modules it did not reach', () => {
  withCacheDir((dir) => {
    const file = path.join(dir, 'module-eval-cycles.json');
    const full = openStore(file);
    runProcess(cachedTree(), full);
    full.save();
    // A second process edits the leaf and scans only from it.
    const edited = cachedTree(undefined, undefined, 'export const LEAF = 2;\n');
    const subset = openStore(file);
    assert.deepEqual(runProcess(edited, subset, ['src/c.ts']), { holes: [], analysed: 1, reused: 0 });
    subset.save();
    assert.deepEqual(runProcess(edited, openStore(file)), { holes: CACHED_TREE_HOLES, analysed: 0, reused: 4 });
  });
});

test('cache: the store starts empty without a file and saves into a directory it creates, leaving no temp file', () => {
  withCacheDir((dir) => {
    const cacheDir = path.join(dir, 'node_modules', '.cache', 'adcp-lint');
    const file = path.join(cacheDir, 'module-eval-cycles.json');
    const store = openStore(file);
    assert.equal(store.get('src/a.ts'), undefined);
    runProcess(cachedTree(), store);
    store.save();
    assert.deepEqual(fs.readdirSync(cacheDir), ['module-eval-cycles.json']);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'the store file must be JSON');
  });
});

// ---------------------------------------------------------------------------
// Negative control: a seeded cycle in the real tree, through the warm store
// ---------------------------------------------------------------------------

const SEEDED_ENTRY = 'server/src/zz-seeded-cycle-a.ts';
const SEEDED_HOLES = ['server/src/zz-seeded-cycle-b.ts:1 reads SEEDED from in-progress server/src/zz-seeded-cycle-a.ts'];

/** Two new server/src modules forming a cycle; the entry also imports a real module subgraph (formats.ts). */
function seededCycleOverlay() {
  return {
    [SEEDED_ENTRY]: [
      "import { useSeeded } from './zz-seeded-cycle-b.js';",
      "import { FormatsService } from './formats.js';",
      'export const SEEDED = { formats: FormatsService };',
      'export function touch() { return useSeeded; }',
    ].join('\n'),
    'server/src/zz-seeded-cycle-b.ts': [
      "import { SEEDED } from './zz-seeded-cycle-a.js';",
      'export const COPY = [SEEDED];',
      'export function useSeeded() { return 1; }',
    ].join('\n'),
  };
}

/** A new reader over the checkout with `overlay` files laid on top. */
function overlayReader(overlay) {
  return (file) => {
    if (Object.hasOwn(overlay, file)) return overlay[file];
    try {
      return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      return undefined;
    }
  };
}

test('negative control: a cycle seeded into the real tree is reported through the warm store, and lint passes its cache through', () => {
  withCacheDir((dir) => {
    const file = path.join(dir, 'module-eval-cycles.json');
    const overlay = seededCycleOverlay();
    const runReal = (store) => {
      const analyzer = createAnalyzer(overlayReader(overlay), { cache: store });
      const holes = analyzer.evaluate(SEEDED_ENTRY).map(holeKey).sort();
      assert.ok(analyzer.stats, 'createAnalyzer must return stats { analysed, reused }');
      return { holes, analysed: analyzer.stats.analysed, reused: analyzer.stats.reused };
    };
    const coldStore = openStore(file);
    const cold = runReal(coldStore);
    coldStore.save();
    assert.equal(cold.reused, 0);
    assert.ok(cold.analysed >= 3, `expected the seeded modules and real ones, analysed ${cold.analysed}`);
    assert.deepEqual(cold.holes, SEEDED_HOLES);
    assert.deepEqual(runReal(openStore(file)), { holes: SEEDED_HOLES, analysed: 0, reused: cold.analysed });

    const lintStore = openStore(path.join(dir, 'lint.json'));
    assert.deepEqual(lint({ entries: [SEEDED_ENTRY], read: overlayReader(overlay), cache: lintStore }).map(holeKey), SEEDED_HOLES);
    assert.notEqual(lintStore.get(SEEDED_ENTRY), undefined, 'lint({ cache }) must hand the store to the analyser');
  });
});
