#!/usr/bin/env node
/**
 * Value-list lint: how a value list is written (#9002).
 *
 * #9002 proposes one open form for every value list in 4.0, with one shared
 * grammar for extension terms. That form isn't decided, so this lint blocks
 * only what every outcome agrees on, and reports the rest:
 *
 * Rules (a new finding fails):
 *
 *   one-value-enum     a string `enum` with one value. A one-value list is a
 *                      literal: write it as `const`. (The 17 existing ones
 *                      stay until 4.0, because `const` changes generated
 *                      literal types.)
 *   extension-branch   a branch beside a string `enum` that admits values the
 *                      enum doesn't list: a `pattern`, `format`, plain string,
 *                      `allOf` or a `$ref` to something that isn't a value
 *                      list. Each existing one is its own grammar
 *                      (`custom:{key}`, `x_{key}`, an HTTPS URI, `trust.json`
 *                      tokens). A new one would add another.
 *
 * Reported, not blocking until the open form is decided:
 *
 *   closed value lists  string enums that are neither a discriminator nor
 *                       beside an extension branch.
 *   x-extensible        lists marked open with `x-extensible`/`x-pattern`,
 *                       outside the schema's validation.
 *
 * Discriminators, detected mechanically: for every `oneOf` or `anyOf`, each
 * branch is read with its `properties` and `required`, following a `$ref`
 * branch and the members of the branch's `allOf`. A property key selects a
 * branch when (1) at least two branches declare it with `const` or a string
 * `enum`, (2) each of those branches requires it, and (3) the value sets they
 * declare are pairwise disjoint. An extension term there would match no
 * branch, so such an enum stays closed in every outcome.
 *
 * Skipped: an `enum` under `not`, `if`, `then`, `else` or `contains` tests or
 * narrows a value; the property's own declaration carries the list. An `enum`
 * with no string value is not a vocabulary.
 */

'use strict';

const path = require('node:path');
const { isSchema, loadSchemaTree, runCli, unescapePointerToken, walkSchema } = require('./schema-convention-lint.cjs');

const DEFAULT_BASELINE_PATH = path.join(__dirname, 'lint-value-lists-baseline.json');
const CONTAINERS = ['properties', 'definitions', '$defs', 'patternProperties'];
const TESTS = ['not', 'if', 'then', 'else', 'contains'];
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const obj = isSchema;

function buildTree(schemasDir) {
  const loaded = loadSchemaTree(schemasDir);
  const files = loaded.documents.map((document) => ({ rel: document.relativePath, doc: document.schema }));
  const byId = new Map();
  for (const file of files) if (obj(file.doc) && typeof file.doc.$id === 'string') byId.set(file.doc.$id, file);
  return { files, byId, parseErrors: loaded.parseErrors };
}

// Resolve a `$ref` to { rel, doc, ptr, node }. Handles `/schemas/...json#/ptr` and `#/ptr`.
function resolve(tree, ref, here) {
  const [id, frag = ''] = String(ref).split('#');
  const base = id ? tree.byId.get(id) : here;
  if (!base) return null;
  let n = base.doc;
  for (const seg of frag.split('/').filter(Boolean)) n = n == null ? undefined : n[unescapePointerToken(seg)];
  return n === undefined ? null : { rel: base.rel, doc: base.doc, ptr: frag, node: n };
}

// Visit every subschema; `keys` is the keyword path from the root.
function visitAll(tree, fn) {
  for (const file of tree.files) {
    for (const { node, pointer } of walkSchema(file.doc)) {
      fn(node, pointer, pointer.split('/').slice(1).map(unescapePointerToken), file);
    }
  }
}

const inTest = (keys) => keys.some((k, i) => TESTS.includes(k) && !CONTAINERS.includes(keys[i - 1]));
const stringEnum = (n) => obj(n) && Array.isArray(n.enum) && n.enum.some((v) => typeof v === 'string');

// Branch view for discriminator detection: properties and required, through $ref and allOf.
function branchView(tree, b, here, depth = 0) {
  const view = { props: new Map(), required: new Set() };
  if (!obj(b) || depth > 4) return view;
  const add = (v) => {
    for (const [k, s] of v.props) if (!view.props.has(k)) view.props.set(k, s);
    for (const r of v.required) view.required.add(r);
  };
  if (typeof b.$ref === 'string') {
    const t = resolve(tree, b.$ref, here.file);
    if (t) add(branchView(tree, t.node, { file: { rel: t.rel, doc: t.doc }, ptr: t.ptr }, depth + 1));
  }
  if (obj(b.properties)) {
    for (const [k, s] of Object.entries(b.properties)) {
      let site = { rel: here.file.rel, ptr: `${here.ptr}/properties/${esc(k)}`, node: s };
      if (obj(s) && typeof s.$ref === 'string' && !('const' in s) && !s.enum) {
        const t = resolve(tree, s.$ref, here.file);
        if (t) site = { rel: t.rel, ptr: t.ptr, node: t.node };
      }
      view.props.set(k, site);
    }
  }
  if (Array.isArray(b.required)) b.required.forEach((r) => view.required.add(r));
  if (Array.isArray(b.allOf)) b.allOf.forEach((m, i) => add(branchView(tree, m, { file: here.file, ptr: `${here.ptr}/allOf/${i}` }, depth + 1)));
  return view;
}

// Returns the set of enum sites that select a union branch.
function discriminators(tree) {
  const out = new Set();
  visitAll(tree, (node, ptr, keys, file) => {
    for (const u of ['oneOf', 'anyOf']) {
      if (!Array.isArray(node[u]) || node[u].length < 2) continue;
      const views = node[u].map((b, i) => branchView(tree, b, { file, ptr: `${ptr}/${u}/${i}` }));
      const keysSeen = new Set(views.flatMap((v) => [...v.props.keys()]));
      for (const k of keysSeen) {
        const decl = views
          .map((v) => ({ v, s: v.props.get(k) }))
          .filter(({ s }) => s && obj(s.node) && (('const' in s.node && typeof s.node.const !== 'object') || stringEnum(s.node)));
        if (decl.length < 2 || !decl.every(({ v }) => v.required.has(k))) continue;
        const sets = decl.map(({ s }) => ('const' in s.node ? [s.node.const] : s.node.enum));
        const seen = new Set();
        let disjoint = true;
        for (const set of sets) for (const val of set) { if (seen.has(val)) disjoint = false; seen.add(val); }
        if (!disjoint) continue;
        for (const { s } of decl) if (Array.isArray(s.node.enum)) out.add(`${s.rel}#${s.ptr}`);
      }
    }
  });
  return out;
}

// A branch beside an enum that admits strings the enum doesn't list.
function extensionBranch(tree, branch, file) {
  if (!obj(branch) || Array.isArray(branch.enum) || 'const' in branch) return null;
  if (branch.type === 'object' || branch.properties) return null;
  if (typeof branch.$ref === 'string') {
    const target = resolve(tree, branch.$ref, file);
    if (target && stringEnum(target.node)) return null;
    return branch.$ref;
  }
  if (typeof branch.pattern === 'string') return branch.pattern;
  if (typeof branch.format === 'string') return `format: ${branch.format}`;
  if (branch.type === 'string') return 'a plain string';
  if (branch.allOf) return 'allOf';
  return null;
}

function lintValueLists({ schemasDir } = {}) {
  const tree = buildTree(schemasDir);
  const discriminatorSites = discriminators(tree);
  const findings = [];
  const covered = new Set();
  let extensible = 0;

  visitAll(tree, (node, ptr, keys, file) => {
    if (node['x-extensible'] !== undefined || node['x-pattern'] !== undefined) extensible += 1;
    for (const u of ['oneOf', 'anyOf']) {
      if (!Array.isArray(node[u])) continue;
      const enumBranches = node[u].map((b, i) => (stringEnum(b) ? i : -1)).filter((i) => i >= 0);
      if (enumBranches.length === 0) continue;
      const other = node[u].map((b) => extensionBranch(tree, b, file)).find(Boolean);
      if (!other) continue;
      findings.push({
        rule: 'extension-branch',
        site: `${file.rel}#${ptr}/${u}`,
        message: `a branch beside the enum admits other values (${other}); #9002 gives extension terms one shared grammar`,
      });
      enumBranches.forEach((i) => covered.add(`${file.rel}#${ptr}/${u}/${i}`));
    }
  });

  let closed = 0;
  let discriminatorCount = 0;
  visitAll(tree, (node, ptr, keys, file) => {
    if (!stringEnum(node) || inTest(keys)) return;
    const site = `${file.rel}#${ptr}`;
    if (covered.has(site)) return;
    if (node.enum.length === 1) {
      findings.push({ rule: 'one-value-enum', site: `${site}/enum`, message: 'a one-value enum is a literal: write it as `const`' });
      return;
    }
    if (discriminatorSites.has(site)) discriminatorCount += 1;
    else closed += 1;
  });

  return {
    findings: findings.sort((a, b) => `${a.rule} ${a.site}`.localeCompare(`${b.rule} ${b.site}`, 'en')),
    errors: tree.parseErrors.map((error) => `schema parse error: ${error}`),
    report: [
      `${discriminatorCount} discriminator enums; reported, not blocking: ${closed} closed value lists, ${extensible} lists marked x-extensible`,
    ],
  };
}

module.exports = { DEFAULT_BASELINE_PATH, discriminators, lintValueLists };

if (require.main === module) {
  process.exitCode = runCli({
    name: 'value-list lint',
    defaultBaselinePath: DEFAULT_BASELINE_PATH,
    baselineComment: 'One-value enums and extension branches beside an enum (scripts/lint-value-lists.cjs, #9002). A new finding fails. The one-value enums become const in 4.0; the extension branches move to one shared grammar once #9002 decides it.',
    lint: lintValueLists,
  });
}
