#!/usr/bin/env node
'use strict';

/**
 * The statuses each task's response admitted before the bodies were split.
 *
 * Until 3.3.0-beta.4, `<task>-response.json` was the task's whole response:
 * its root composed the protocol envelope, whose `status` is the task-status
 * enum, and it left `status` open unless the schema pinned it. This script
 * reads such a tree (a built `dist/schemas/<version>` tree, or a checkout's
 * build) and reports, per task, the statuses the response schema admits: a
 * status is admitted unless every branch of a root `oneOf`/`anyOf` pins
 * `status` to other values, a root `status` declaration leaves it out, or a
 * root `not` excludes it. A status is admitted openly when some path admits
 * it without pinning it (the open root, or a branch with no status of its
 * own) and no `if` on `status` gives it a rule of its own, so the
 * response's general rules applied to it; otherwise only a branch or a
 * condition that names it does.
 *
 * `scripts/task-response-statuses.json` records the result for the tree the
 * bodies were split from, and the schema build gives each recorded status a
 * branch in the task's generated response (scripts/task-responses.cjs).
 *
 * Usage: node scripts/derive-task-response-statuses.cjs <built-tree> [--write]
 */

const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = /^https?:\/\/[^/]+\/schemas\/(?:latest|v?\d+(?:\.\d+)*(?:-[\w.]+)?)\//;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function documentPath(tree, ref, fromRel) {
  const [file] = ref.split('#');
  if (!file) return fromRel;
  if (ORIGIN.test(file)) return file.replace(ORIGIN, '');
  if (file.startsWith('/schemas/')) return file.slice('/schemas/'.length);
  return path.posix.join(path.posix.dirname(fromRel), file);
}

function pointer(doc, fragment) {
  if (!fragment) return doc;
  return fragment.slice(1).split('/').reduce((node, segment) => (node ? node[segment.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
}

/** The statuses a status declaration admits, or null when it pins none. */
function declared(status, all) {
  if (!status || typeof status !== 'object') return null;
  if (typeof status.const === 'string') return new Set([status.const]);
  if (Array.isArray(status.enum)) return new Set(status.enum.filter((value) => all.includes(value)));
  return null;
}

function intersect(a, b) {
  return new Set([...a].filter((value) => b.has(value)));
}

/** The statuses a `not` excludes: a status pin it requires, or any of an `anyOf` of them. */
function excludedBy(not, all) {
  if (!not || typeof not !== 'object') return new Set();
  const pinned = (node) => (node && Array.isArray(node.required) && node.required.includes('status')
    ? declared(node.properties && node.properties.status, all)
    : null);
  const out = new Set();
  for (const node of [not, ...(Array.isArray(not.anyOf) ? not.anyOf : [])]) {
    const values = pinned(node);
    if (values) values.forEach((value) => out.add(value));
  }
  return out;
}

/**
 * The statuses a node admits for the response object, from `all`, as
 * `{ admitted, open }`. `open` maps each status the node admits without
 * pinning it, and without a condition of its own, to the kinds of content
 * that admit it: `failed` for a branch that requires `errors` (an error
 * branch), `completed` otherwise. `kind` is the kind of the enclosing node.
 */
function admitted(tree, rel, node, all, seen = new Set(), kind = 'completed') {
  const everything = (k) => ({ admitted: new Set(all), open: new Map(all.map((status) => [status, new Set([k])])) });
  if (!node || typeof node !== 'object') return everything(kind);
  const ownKind = Array.isArray(node.required) && node.required.includes('errors') ? 'failed' : kind;
  if (typeof node.$ref === 'string') {
    const targetRel = documentPath(tree, node.$ref, rel);
    const key = `${targetRel}#${node.$ref.split('#')[1] || ''}`;
    if (seen.has(key)) return everything(ownKind);
    const file = path.join(tree, targetRel);
    if (!fs.existsSync(file)) return everything(ownKind);
    const target = pointer(readJson(file), node.$ref.split('#')[1] || '');
    const { $ref, ...siblings } = node;
    return conjoin(admitted(tree, targetRel, target, all, new Set(seen).add(key), ownKind), admitted(tree, rel, siblings, all, seen, ownKind));
  }
  let result = everything(ownKind);
  const own = declared(node.properties && node.properties.status, all);
  // A declaration that names every status pins none.
  if (own && own.size < all.length) result = { admitted: own, open: new Map() };
  for (const member of Array.isArray(node.allOf) ? node.allOf : []) result = conjoin(result, admitted(tree, rel, member, all, seen, ownKind));
  for (const keyword of ['oneOf', 'anyOf']) {
    if (!Array.isArray(node[keyword])) continue;
    const union = { admitted: new Set(), open: new Map() };
    for (const branch of node[keyword]) {
      const b = admitted(tree, rel, branch, all, seen, ownKind);
      b.admitted.forEach((value) => union.admitted.add(value));
      for (const [status, kinds] of b.open) {
        if (!union.open.has(status)) union.open.set(status, new Set());
        kinds.forEach((k) => union.open.get(status).add(k));
      }
    }
    // The node's own content admits a status only through one of its branches.
    result = { admitted: intersect(result.admitted, union.admitted), open: new Map([...union.open].filter(([status]) => result.open.has(status))) };
  }
  // A condition on status, or a chain of them through `else`, gives the
  // statuses it names their own rule.
  for (let link = node; link && typeof link === 'object' && link.if; link = link.else) {
    const condition = typeof link.if === 'object' ? declared(link.if.properties && link.if.properties.status, all) : null;
    if (condition) for (const status of condition) result.open.delete(status);
  }
  for (const status of excludedBy(node.not, all)) {
    result.admitted.delete(status);
    result.open.delete(status);
  }
  for (const status of [...result.open.keys()]) if (!result.admitted.has(status)) result.open.delete(status);
  return result;
}

/** Both nodes at once: what both admit, open in both, with the kinds of the inner one. */
function conjoin(a, b) {
  const open = new Map();
  for (const [status, kinds] of a.open) {
    if (!b.open.has(status)) continue;
    // The more specific node (the branch) decides the kind of content.
    open.set(status, new Set([...kinds].filter((k) => b.open.get(status).has(k)).length ? [...kinds].filter((k) => b.open.get(status).has(k)) : kinds));
  }
  return { admitted: intersect(a.admitted, b.admitted), open };
}

/**
 * `{ "<protocol>/<task>": { admitted: [status, ...], open: { status: [kind, ...] } } }`
 * for every task response in the tree.
 */
function deriveTaskResponseStatuses(tree) {
  const all = readJson(path.join(tree, 'enums', 'task-status.json')).enum;
  const manifest = readJson(path.join(tree, 'manifest.json'));
  const tools = Array.isArray(manifest.tools) ? manifest.tools : Object.values(manifest.tools);
  const rels = new Set(tools.map((tool) => tool.response_schema));
  // Responses that tasks share, published under the same naming.
  for (const extra of ['media-buy/media-buy-commitment-response.json']) {
    if (fs.existsSync(path.join(tree, extra))) rels.add(extra);
  }
  // list_creative_formats is published in two protocols.
  for (const rel of [...rels]) {
    const base = path.posix.basename(rel);
    for (const dir of fs.readdirSync(tree, { withFileTypes: true })) {
      if (dir.isDirectory() && fs.existsSync(path.join(tree, dir.name, base)) && fs.existsSync(path.join(tree, dir.name, base.replace(/-response\.json$/, '-request.json')))) {
        rels.add(`${dir.name}/${base}`);
      }
    }
  }
  const out = {};
  for (const rel of [...rels].sort()) {
    const doc = readJson(path.join(tree, rel));
    const statuses = admitted(tree, rel, doc, all);
    out[rel.replace(/-response\.json$/, '')] = {
      admitted: all.filter((status) => statuses.admitted.has(status)),
      open: Object.fromEntries(all.filter((status) => statuses.open.has(status))
        .map((status) => [status, ['completed', 'failed'].filter((k) => statuses.open.get(status).has(k))])),
    };
  }
  return out;
}

module.exports = { deriveTaskResponseStatuses };

if (require.main === module) {
  const [tree, flag] = process.argv.slice(2);
  if (!tree) {
    console.error('usage: derive-task-response-statuses.cjs <built-tree> [--write]');
    process.exit(2);
  }
  const statuses = deriveTaskResponseStatuses(path.resolve(tree));
  const text = `${JSON.stringify(statuses, null, 2)}\n`;
  if (flag === '--write') fs.writeFileSync(path.join(__dirname, 'task-response-statuses.json'), text);
  else process.stdout.write(text);
}
