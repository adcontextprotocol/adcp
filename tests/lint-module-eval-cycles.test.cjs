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
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAnalyzer, formatViolation, holeKey, lint, scan, scopeFiles } = require('../scripts/lint-module-eval-cycles.cjs');

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
