#!/usr/bin/env node
/**
 * Inventory of unbounded arrays and strings in static/schemas/source/**.
 *
 * Why: the working group decided (WG Session C, 2026-10-26) to bound list
 * sizes and string lengths across the protocol. Tightening a released field
 * is not a minor-release change, so this script classifies every unbounded
 * node by stability and proposes a limit for each, and a 3.3 slice may touch
 * only the nodes that are new in 3.3 or experimental.
 *
 * What it records, for every array without `maxItems` and every string
 * without `maxLength` (strings constrained by `enum`, `const`, a fixed-length
 * `format` or a bounded `pattern` are skipped):
 *
 *   - file and JSON Pointer
 *   - side: request, response, both, or other (reachable from no task
 *     request/response schema, for example adagents.json or registry documents)
 *   - stability: stable | experimental | new-3.3
 *   - a proposed limit, its tier and a one-line rationale
 *   - action: apply in 3.3, tighten in 4.0, or move out of band (4.0)
 *
 * It also lists every array that carries a property or collection list INLINE
 * (an array of properties or domains) instead of by reference, bounded or not.
 * The WG rule is that such lists are always passed by reference.
 *
 * Usage:
 *   node scripts/audit-schema-bounds.cjs                 print the summary
 *   node scripts/audit-schema-bounds.cjs --write         rewrite the inventory JSON
 *   node scripts/audit-schema-bounds.cjs --check         fail if the committed inventory is stale
 *   node scripts/audit-schema-bounds.cjs --check-unreleased
 *                                                        fail if an unbounded array or string is new in 3.3
 *                                                        or experimental (the 3.3 slice is complete)
 *   node scripts/audit-schema-bounds.cjs --json          print the inventory to stdout
 *
 * Stability rules (conservative, so that an edit proposed for 3.3 can never
 * touch a released field):
 *   - experimental: the node or an ancestor in the same file carries
 *     `x-status: "experimental"`.
 *   - new-3.3: not experimental, and the node or an ancestor in the same file
 *     carries `x-added-in: "3.3.0"`, and the same pointer is not present in
 *     the last stable release (dist/schemas/3.2.7). A marker that conflicts
 *     with the release is reported as stable.
 *   - stable: everything else. `absent_from_last_stable` is recorded for these
 *     too, as a signal that a marker is missing; it never promotes a node.
 *
 * Limits of the analysis: $ref resolution covers `/schemas/...` ids and
 * in-file `#/...` pointers; side tracing follows $refs but not prose.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static/schemas/source');
const DIST_DIR = path.join(REPO_ROOT, 'dist/schemas');
const INVENTORY_PATH = path.join(__dirname, 'schema-bounds-inventory.json');
const LAST_STABLE = '3.2.7';
const NEW_VERSION = '3.3.0';

// Schemas another workstream owns. The inventory records every node reachable
// from them, through $refs, but the 3.3 slice does not edit those nodes: the
// owner documents a worst-case size for the response that a new bound would move.
const OWNED_ELSEWHERE = {
  'protocol/get-adcp-capabilities-response.json': '#8198',
};

// Formats the inventory skips. `uri` is skipped on request but is not length-bounded, so it is counted separately.
// Nodes the SDK generators cannot carry a bound on today. Each was found by
// regenerating the TypeScript and Python SDKs from a bundle that bounded it
// (the validate-schema-bundle workflow runs the same generation).
const SDK_GENERATION_EXCLUSIONS = {
  'core/targeting.json#/properties/collection_lists': 'the TypeScript SDK hoists the bounded array into a type alias and cannot restore its maxItems',
  'core/targeting.json#/properties/collection_lists_exclude': 'the TypeScript SDK hoists the bounded array into a type alias and cannot restore its maxItems',
  'brand/update-rights-response.json#/oneOf/0/properties/generation_credentials': 'the Python SDK post-generation fix fix_update_rights_legacy_response_defaults matches the unbounded field text',
};

const SKIP_FORMATS = new Set(['date-time', 'uri', 'email', 'uuid', 'date', 'time', 'ipv4', 'ipv6']);

// Keywords whose value is a subschema, a list of subschemas, or a map of them.
const SCHEMA_KEYS = ['additionalProperties', 'items', 'additionalItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties'];
const SCHEMA_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', 'definitions', '$defs'];

// ---------------------------------------------------------------------------
// Loading and pointers
// ---------------------------------------------------------------------------

function listJson(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJson(full, base);
    return entry.name.endsWith('.json') ? [path.relative(base, full).split(path.sep).join('/')] : [];
  });
}

const esc = seg => String(seg).replace(/~/g, '~0').replace(/\//g, '~1');

function getPointer(doc, pointer) {
  if (pointer === '' || pointer === '#') return doc;
  let node = doc;
  for (const raw of pointer.replace(/^#/, '').split('/').slice(1)) {
    const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(seg in node)) return undefined;
    node = node[seg];
  }
  return node;
}

/** Calls fn(node, pointer, ancestors) for every subschema in a document. */
function walkSchemas(node, pointer, fn, ancestors = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  fn(node, pointer, ancestors);
  const next = [...ancestors, node];
  for (const key of SCHEMA_KEYS) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c, i) => walkSchemas(c, `${pointer}/${key}/${i}`, fn, next));
    else if (child && typeof child === 'object') walkSchemas(child, `${pointer}/${key}`, fn, next);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    if (Array.isArray(node[key])) node[key].forEach((c, i) => walkSchemas(c, `${pointer}/${key}/${i}`, fn, next));
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [name, child] of Object.entries(map)) walkSchemas(child, `${pointer}/${key}/${esc(name)}`, fn, next);
    }
  }
  if (node.dependencies && typeof node.dependencies === 'object') {
    for (const [name, child] of Object.entries(node.dependencies)) {
      if (!Array.isArray(child)) walkSchemas(child, `${pointer}/dependencies/${esc(name)}`, fn, next);
    }
  }
}

function resolveRef(ref, fromFile, docs) {
  const [target, fragment = ''] = ref.split('#');
  let file = fromFile;
  if (target) {
    file = target.startsWith('/schemas/') ? target.slice('/schemas/'.length) : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  }
  const doc = docs.get(file);
  if (!doc) return null;
  const pointer = fragment ? (fragment.startsWith('/') ? fragment : null) : '';
  if (pointer === null) return null;
  const node = getPointer(doc, pointer);
  return node === undefined ? null : { file, pointer, node };
}

// ---------------------------------------------------------------------------
// Classification of nodes
// ---------------------------------------------------------------------------

function typeIncludes(node, type) {
  return node.type === type || (Array.isArray(node.type) && node.type.includes(type));
}

/** True when a pattern is anchored at both ends and has no unbounded quantifier. */
function isBoundedPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$')) return false;
  const stripped = pattern.replace(/\\./g, '_').replace(/\[(?:\\.|[^\]\\])*\]/g, '_');
  if (/[*+]/.test(stripped) || /\{\d+,\}/.test(stripped)) return false;
  if (/\(\?[=!<]/.test(stripped)) return false;
  return true;
}

function branchesAreClosed(node) {
  for (const key of ['oneOf', 'anyOf']) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.length > 0 && branches.every(b => b && (b.const !== undefined || Array.isArray(b.enum)))) return true;
  }
  return false;
}

function stringSkipReason(node) {
  if (Array.isArray(node.enum)) return 'enum';
  if (node.const !== undefined) return 'const';
  if (node.format && SKIP_FORMATS.has(node.format)) return `format:${node.format}`;
  if (branchesAreClosed(node)) return 'closed-branches';
  if (isBoundedPattern(node.pattern)) return 'bounded-pattern';
  if (typeof node.maxLength === 'number') return 'bounded';
  return null;
}

/**
 * A definition (or file) that no release contains and that only new or
 * experimental nodes reference is itself new, even without its own marker.
 * Returns 'experimental' | 'new-3.3' | null.
 */
function buildInboundIndex(docs) {
  const inbound = new Map();
  for (const [file, doc] of docs) {
    walkSchemas(doc, '', (node, pointer, ancestors) => {
      if (typeof node.$ref !== 'string') return;
      const target = resolveRef(node.$ref, file, docs);
      if (!target) return;
      const chain = [...ancestors, node];
      const key = `${target.file}#${target.pointer}`;
      if (!inbound.has(key)) inbound.set(key, []);
      const top = pointer.match(/^\/(definitions|\$defs)\/[^/]+/);
      inbound.get(key).push({
        experimental: chain.some(n => n['x-status'] === 'experimental'),
        marked: chain.some(n => n['x-added-in'] === NEW_VERSION),
        from: { file, rootPointer: top ? top[0] : '', pointer },
      });
    });
  }
  return inbound;
}

function derivedNewness(file, pointer, inbound, lastStableDocs, visiting = new Set()) {
  const top = pointer.match(/^\/(definitions|\$defs)\/[^/]+/);
  const rootPointer = top ? top[0] : '';
  const prior = lastStableDocs.get(file);
  if (prior && (!top || getPointer(prior, rootPointer) !== undefined)) return null;
  const key = `${file}#${rootPointer}`;
  const refs = inbound.get(key);
  if (!refs || refs.length === 0 || visiting.has(key)) return null;
  visiting.add(key);
  // A reference from a definition that is itself new counts as new.
  const kinds = refs.map(r => {
    if (r.experimental) return 'experimental';
    if (r.marked) return 'new-3.3';
    return derivedNewness(r.from.file, r.from.rootPointer, inbound, lastStableDocs, visiting);
  });
  visiting.delete(key);
  if (kinds.every(k => k === 'experimental')) return 'experimental';
  return kinds.every(Boolean) ? 'new-3.3' : null;
}


// ---------------------------------------------------------------------------
// Wire-path check against the last stable release
// ---------------------------------------------------------------------------
//
// A field can be new in a file yet old on the wire: 3.3 moved the relying-party
// object out of brand.json into core/identity-relying-party.json, so the new
// file's properties are absent from the 3.2.7 file of the same name. Comparing
// pointers per file would call them new. Instead, walk from every schema that
// references the node back to its roots, and ask whether 3.2.7 has the same
// path from the same root, following $refs on both sides. Combiner branches
// are searched without regard to index, so a doubtful match counts as
// existing, which keeps the node stable.

const DEF_ROOT = /^\/(definitions|\$defs)\/[^/]+/;
const MAX_WIRE_PATHS = 4000;

/** Wire paths to a node as [{root, segs}], where segs are keyword steps from the root file. */
function wirePaths(file, pointer, inbound, memo, active = new Set()) {
  const def = pointer.match(DEF_ROOT);
  const rootPointer = def ? def[0] : '';
  const suffix = pointer.slice(rootPointer.length).split('/').filter(Boolean).map(seg => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  const key = `${file}#${rootPointer}`;
  let base = memo.get(key);
  if (!base) {
    base = [];
    if (!rootPointer) base.push({ root: file, segs: [] });
    if (!active.has(key)) {
      active.add(key);
      for (const ref of inbound.get(key) || []) {
        for (const p of wirePaths(ref.from.file, ref.from.pointer, inbound, memo, active)) {
          base.push(p);
          if (base.length >= MAX_WIRE_PATHS) break;
        }
        if (base.length >= MAX_WIRE_PATHS) break;
      }
      active.delete(key);
    }
    if (active.size === 0) memo.set(key, base);
  }
  return base.map(p => ({ root: p.root, segs: [...p.segs, ...suffix] }));
}

/** Nodes that a schema node stands for: itself, its $ref target and every combiner branch, transitively. */
function expand(node, file, docs, seen = new Set()) {
  const out = [];
  const stack = [{ node, file }];
  while (stack.length) {
    const { node: n, file: f } = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    out.push({ node: n, file: f });
    if (typeof n.$ref === 'string') {
      const target = resolveRef(n.$ref, f, docs);
      if (target) stack.push({ node: target.node, file: target.file });
    }
    for (const k of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(n[k])) for (const b of n[k]) stack.push({ node: b, file: f });
    for (const k of ['if', 'then', 'else']) if (n[k]) stack.push({ node: n[k], file: f });
  }
  return out;
}

/** Looks the segment path up in the last stable release; returns {found, onlyExperimental}. */
function lookupWire(docs, root, segs) {
  const doc = docs.get(root);
  if (!doc) return { found: false, onlyExperimental: false };
  let frontier = [{ node: doc, file: root, experimental: doc['x-status'] === 'experimental' }];
  for (let i = 0; i < segs.length && frontier.length; i++) {
    const seg = segs[i];
    const next = [];
    // Combiner indexes, and the `properties` / `items` keywords themselves, carry no meaning here.
    if (/^(oneOf|anyOf|allOf|prefixItems)$/.test(seg) || /^\d+$/.test(seg)) continue;
    for (const cur of frontier) {
      for (const { node, file } of expand(cur.node, cur.file, docs)) {
        const exp = cur.experimental || node['x-status'] === 'experimental';
        let child;
        if (seg === 'properties' || seg === 'patternProperties') {
          const name = segs[i + 1];
          child = node[seg] && node[seg][name];
          if (child) next.push({ node: child, file, experimental: exp || child['x-status'] === 'experimental', skip: 1 });
          continue;
        }
        if (seg === 'items' || seg === 'additionalProperties' || seg === 'additionalItems' || seg === 'contains' || seg === 'propertyNames' || seg === 'not') {
          child = Array.isArray(node[seg]) ? undefined : node[seg];
          if (child && typeof child === 'object') next.push({ node: child, file, experimental: exp || child['x-status'] === 'experimental', skip: 0 });
          continue;
        }
        if (seg === 'definitions' || seg === '$defs') {
          child = node[seg] && node[seg][segs[i + 1]];
          if (child) next.push({ node: child, file, experimental: exp || child['x-status'] === 'experimental', skip: 1 });
        }
      }
    }
    // `properties` and `definitions` consume the following name segment.
    const consumed = next.find(n => n.skip === 1);
    if (consumed) i += 1;
    frontier = next.map(({ node, file, experimental }) => ({ node, file, experimental }));
  }
  if (!frontier.length) return { found: false, onlyExperimental: false };
  return { found: true, onlyExperimental: frontier.every(f => f.experimental) };
}

/**
 * Re-checks a node that the markers call new or experimental. Returns
 * 'released' when 3.2.7 carries it on the wire as a stable field, 'experimental-then'
 * when 3.2.7 carried it but already marked experimental, and 'absent' otherwise.
 */
function releasedOnWire(file, pointer, inbound, memo, lastStableDocs) {
  const paths = wirePaths(file, pointer, inbound, memo);
  if (paths.length === 0) return 'absent';
  let experimentalThen = false;
  for (const p of paths) {
    const hit = lookupWire(lastStableDocs, p.root, p.segs);
    if (hit.found && !hit.onlyExperimental) return 'released';
    if (hit.found) experimentalThen = true;
  }
  return experimentalThen ? 'experimental-then' : 'absent';
}

function stabilityOf(file, pointer, ancestors, node, lastStableDocs, inbound, wireMemo) {
  const chain = [...ancestors, node];
  const experimental = chain.some(n => n['x-status'] === 'experimental');
  const marked = chain.some(n => n['x-added-in'] === NEW_VERSION);
  const priorDoc = lastStableDocs.get(file);
  const indexed = /\/(oneOf|anyOf|allOf|prefixItems)\/\d+(\/|$)/.test(pointer);
  let inLastStable = 'unknown';
  if (!priorDoc) inLastStable = 'no';
  else if (getPointer(priorDoc, pointer) !== undefined) inLastStable = 'yes';
  else if (!indexed) inLastStable = 'no';
  let stability = experimental ? 'experimental' : marked && inLastStable !== 'yes' ? 'new-3.3' : 'stable';
  let derived = false;
  if (stability === 'stable') {
    const viaRefs = derivedNewness(file, pointer, inbound, lastStableDocs);
    if (viaRefs) {
      stability = viaRefs;
      derived = true;
    }
  }
  let wireConflict = false;
  if (stability !== 'stable') {
    const wire = releasedOnWire(file, pointer, inbound, wireMemo, lastStableDocs);
    if (wire === 'released') {
      stability = 'stable';
      wireConflict = true;
    } else if (wire === 'experimental-then') {
      stability = 'experimental';
    }
  }
  return { stability, derived, markedNew: marked, inLastStable, markerConflict: (marked && inLastStable === 'yes' && !experimental) || wireConflict };
}

// ---------------------------------------------------------------------------
// Side tracing: which task request/response schemas reach each node
// ---------------------------------------------------------------------------

const REQUEST_ROOT = /-request\.json$/;
const RESPONSE_ROOT = /(-response\.json|-async-response-[a-z-]+\.json|-webhook(-[a-z-]+)?\.json|-webhook-payload\.json)$/;

function rootSide(file) {
  if (REQUEST_ROOT.test(file)) return 'request';
  if (RESPONSE_ROOT.test(file)) return 'response';
  return null;
}

function traceSides(docs) {
  const reached = new Map(); // `${file}#${pointer}` -> Set('request' | 'response')
  const unresolved = new Set();
  for (const side of ['request', 'response']) {
    const seen = new Set();
    const visit = (file, pointer, node) => {
      const key = `${file}#${pointer}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!reached.has(key)) reached.set(key, new Set());
      reached.get(key).add(side);
      if (typeof node.$ref === 'string') {
        const target = resolveRef(node.$ref, file, docs);
        if (target) visit(target.file, target.pointer, target.node);
        else unresolved.add(`${file}#${pointer} -> ${node.$ref}`);
      }
      const children = [];
      for (const k of SCHEMA_KEYS) {
        const c = node[k];
        if (Array.isArray(c)) c.forEach((x, i) => children.push([`${pointer}/${k}/${i}`, x]));
        else if (c && typeof c === 'object') children.push([`${pointer}/${k}`, c]);
      }
      for (const k of SCHEMA_LIST_KEYS) {
        if (Array.isArray(node[k])) node[k].forEach((x, i) => children.push([`${pointer}/${k}/${i}`, x]));
      }
      for (const k of ['properties', 'patternProperties']) {
        if (node[k] && typeof node[k] === 'object') for (const [n, x] of Object.entries(node[k])) children.push([`${pointer}/${k}/${esc(n)}`, x]);
      }
      for (const [p, c] of children) if (c && typeof c === 'object' && !Array.isArray(c)) visit(file, p, c);
    };
    for (const [file, doc] of docs) if (rootSide(file) === side) visit(file, '', doc);
  }
  return { reached, unresolved };
}

/** Every node reachable from one schema file, following $refs: a Set of `${file}#${pointer}`. */
function reachableFrom(docs, rootFile) {
  const seen = new Set();
  const visit = (file, pointer, node) => {
    const key = `${file}#${pointer}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (typeof node.$ref === 'string') {
      const target = resolveRef(node.$ref, file, docs);
      if (target) visit(target.file, target.pointer, target.node);
    }
    walkChildren(node, pointer, (p, c) => visit(file, p, c));
  };
  if (docs.has(rootFile)) visit(rootFile, '', docs.get(rootFile));
  return seen;
}

function walkChildren(node, pointer, fn) {
  for (const k of SCHEMA_KEYS) {
    const c = node[k];
    if (Array.isArray(c)) c.forEach((x, i) => fn(`${pointer}/${k}/${i}`, x));
    else if (c && typeof c === 'object') fn(`${pointer}/${k}`, c);
  }
  for (const k of SCHEMA_LIST_KEYS) {
    if (Array.isArray(node[k])) node[k].forEach((x, i) => fn(`${pointer}/${k}/${i}`, x));
  }
  for (const k of ['properties', 'patternProperties']) {
    if (node[k] && typeof node[k] === 'object') for (const [n, x] of Object.entries(node[k])) fn(`${pointer}/${k}/${esc(n)}`, x);
  }
}

// ---------------------------------------------------------------------------
// Proposed limits
// ---------------------------------------------------------------------------

const TIERS = {
  'array-enum': 'Set of enum values: bounded by the enum, with a floor of 32.',
  'array-small': 'Small closed sets and tuples (tags, sizes, flags, ranges): 32.',
  'array-typical': 'Typical lists nested inside an object: 100.',
  'array-batch': 'Request batches and result pages: 100 per request, 1,000 in the response that echoes them.',
  'array-large': 'Id, identifier and domain lists that scale with an account or portfolio: 1,000.',
  'array-catalog': 'Catalog-scale payloads (items, records, events, audience members): 10,000.',
  'string-code': 'Short codes and tokens: 64.',
  'string-id': 'Identifiers, names and labels: 255 (the repository default; 262 fields already use it).',
  'string-domain': 'DNS names: 253 (RFC 1035).',
  'string-text': 'Short free text (reasons, messages, descriptions): 2,000 (the repository default for prose).',
  'string-note': 'One-line notes and summaries: 500.',
  'string-url': 'URLs and locators: 2,048.',
  'string-token': 'Opaque tokens, cursors and signatures: 4,096.',
  'string-body': 'Long bodies (markup, scripts, transcripts, briefs): 100,000.',
  'string-blob': 'Encoded binary or inline documents: 1,048,576, the existing markup ceiling.',
  'string-generic': 'No name signal: 500, to be confirmed by the owning working group.',
};

// The property name a node is declared under, or the name of the nearest
// enclosing property for items and branches. Keyword segments are told apart
// from property names by position: the segment after `properties` is a name.
const nameOf = pointer => {
  const parts = pointer.split('/').slice(1).map(seg => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  let name = '';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (['properties', 'patternProperties', 'definitions', '$defs'].includes(seg) && i + 1 < parts.length) {
      name = parts[++i];
    } else if (seg === 'additionalProperties') {
      name = name || seg;
    }
  }
  return name;
};

function enumSizeOfItems(node, file, docs) {
  let items = node.items;
  for (let hops = 0; items && typeof items === 'object' && hops < 4; hops++) {
    if (Array.isArray(items.enum)) return items.enum.length;
    if (items.const !== undefined) return 1;
    if (branchesAreClosed(items)) return (items.oneOf || items.anyOf).length;
    if (typeof items.$ref !== 'string') return 0;
    const target = resolveRef(items.$ref, file, docs);
    if (!target) return 0;
    items = target.node;
    file = target.file;
  }
  return 0;
}

// A bound on a type that mixes string or array with another non-null type (for
// example ["integer", "string"]) breaks SDK code generation: it becomes
// z.union([...]).max(N).
function isMixedType(node) {
  return Array.isArray(node.type) && node.type.filter(t => t !== 'null').length > 1;
}

function actionFor(inlineKind, stability, owner, file, pointer, node) {
  if (inlineKind) return 'move out of band (4.0)';
  if (stability === 'stable') return 'tighten in 4.0';
  if (owner) return `deferred (${owner})`;
  if (SDK_GENERATION_EXCLUSIONS[`${file}#${pointer}`] || isMixedType(node)) return 'deferred (SDK generation)';
  return 'apply in 3.3';
}

const ARRAY_RULES = [
  [/^(errors|warnings|issues|violations|findings|diagnostics|advisories|notices)$/, 'array-typical', 100, 'Diagnostics: more than 100 entries in one payload is a flood, not information.'],
  [/(^|_)(records|events|rows|reporting_rows|audience_members|catalog_items|item_availability[a-z_]*)$/, 'array-catalog', 10000, 'Catalog-scale payload; matches the 10,000 ceiling already used for records and events.'],
  [/(^|_)(signing_keys|encryption_keys|keys|jwks|uids|identifiers|industry_identifiers|names|filters_applied|refinement_applied|[a-z_]*_applied)$/, 'array-small', 32, 'Attributes of one object (keys, identifiers, applied filters); more than 32 is a modelling error.'],
  [/(^|_)(tags|labels|keywords|categories|topics|channels|formats|languages|locales|countries|regions|platforms|devices|dimensions|sizes|types|modes|methods|scopes|features|capabilities|protocols|schemes|metrics|breakdowns|dayparts|weekdays|days)$/, 'array-small', 32, 'Closed or near-closed vocabulary; a payload naming more than 32 is a modelling error.'],
  [/(^|_)(ids|refs|urls|domains|handles|segments_ids|zips|postal_codes|dmas|cities)$/, 'array-large', 1000, 'Id-like list that scales with an account or portfolio; 1,000 keeps one payload well under the 4 MiB response default.'],
];

// Lists that are the resolved output of a by-reference read or an authoring source.
const ARRAY_FILE_OVERRIDES = {
  'trust/v1/trust-acknowledgements.json#acknowledgements': ['array-catalog', 10000, 'Out-of-band shard for organizations that accept thousands of grants; it must hold more than the 500 allowed inline in trust.json.'],
  'trust/v1/trust.json#grants': ['array-large', 500, 'The description says a record may carry a few hundred inline grants before moving to a URL.'],
  'trust/v1/trust.json#acknowledgements': ['array-large', 500, 'The description says a record may carry a few hundred inline acknowledgements before moving to a URL.'],
  'core/catalog.json#items': ['array-catalog', 10000, 'Inline catalog data; matches the 10,000 ceiling for records. Larger catalogs use url.'],
  'property/get-property-list-response.json#identifiers': ['array-catalog', 10000, 'Resolved page of a property list read by reference; matches the 10,000 ceiling for records.'],
  'collection/get-collection-list-response.json#identifiers': ['array-catalog', 10000, 'Resolved page of a collection list read by reference; matches the 10,000 ceiling for records.'],
};

function proposeArray(node, file, pointer, side, docs, markedPaged) {
  const enumSize = enumSizeOfItems(node, file, docs);
  if (enumSize > 0) {
    return { tier: 'array-enum', limit: Math.max(32, enumSize), rationale: `Enum-valued items (${enumSize} values), so the enum bounds it; 32 floor.` };
  }
  const name = nameOf(pointer);
  const override = ARRAY_FILE_OVERRIDES[`${file}#${name}`];
  if (override) return { tier: override[0], limit: override[1], rationale: override[2] };
  for (const [re, tier, limit, rationale] of ARRAY_RULES) {
    if (re.test(name)) {
      if (tier === 'array-large' && side === 'request') {
        return { tier: 'array-batch', limit: 100, rationale: 'Request id list; 100 matches creative_ids, media_buy_ids and task_ids, which are already bounded at 100.' };
      }
      return { tier, limit, rationale };
    }
  }
  if (markedPaged) return { tier: 'array-batch', limit: 1000, rationale: 'Result page: the request page cap is 100, so 1,000 leaves headroom for unpaginated sellers.' };
  if (side === 'request') return { tier: 'array-batch', limit: 100, rationale: 'Request batch or nested list; 100 matches creative_ids, accounts and changes.' };
  return { tier: 'array-typical', limit: 100, rationale: 'Typical nested list; 100 until the owning group names a real ceiling.' };
}

const STRING_RULES = [
  [/(^|_)(content|markup|html|transcript|script|brief|prompt|template|css|js|vast|daast|xml|text_content)$|^(body|document)$/, 'string-body', 100000, 'Long-form body; matches content (100,000) and transcript (200,000) already in the schemas.'],
  [/(^|_)(blob|data|payload|encoded|base64|binary|attachment|file_content)$/, 'string-blob', 1048576, 'Encoded or inline document; capped at the 1 MiB markup ceiling.'],
  [/(^|_)(url|uri|href|endpoint|location|link|webhook|callback|origin|agent_url|image_url|click_url|impression_url)s?$/, 'string-url', 2048, 'URL-shaped value; 2,048 is the repository default and the common browser limit.'],
  [/(^|_)(domain|hostname|host|publisher_domain|subdomain)$/, 'string-domain', 253, 'DNS name, at most 253 octets (RFC 1035).'],
  [/(^|_)(cursor|token|signature|jws|jwt|credentials?|secret|nonce|etag|digest|hash|sha256|public_key|certificate)$/, 'string-token', 4096, 'Opaque token; 4,096 matches cursor and token fields already bounded.'],
  [/(^|_)(description|message|reason|reasons|detail|details|explanation|instructions|rationale|justification|comment|comments|notes?|remediation|suggestion|guidance|policy|terms|disclaimer|caption|alt_text|body_text|copy|headline|title|subject|question|query|text|summary|definition|usage|criteria|condition)$/, 'string-text', 2000, 'Prose for a human or model; 2,000 is the repository default (41 fields).'],
  [/(^|_)(code|currency|country|region|language|locale|timezone|unit|version|namespace|tag|postal_code)$/, 'string-code', 64, 'Short code or version; 64 covers every registered value with room.'],
  [/(^|_)(id|ids|ref|key|name|label|slug|handle|identifier|uid|sku|gtin|isbn|brand|advertiser|operator|owner|agent|seller|buyer|publisher|vendor|campaign|platform|source|destination|account|property|product|package|creative|asset|segment|signal|audience|catalog|feed|list|plan|task|session|trace|request|correlation|idempotency|context|reference)(_[a-z0-9]+)*$/, 'string-id', 255, 'Identifier or name; 255 is the repository default (262 fields).'],
];

// Field-specific limits that the name rules cannot infer. Keyed by property name.
const STRING_OVERRIDES = {
  $schema: ['string-url', 2048, 'JSON Schema URI.'],
  us_privacy: ['string-code', 16, 'IAB US Privacy string is 4 characters; 16 leaves room for a future revision.'],
  tcf_consent: ['string-token', 4096, 'IAB TCF consent string; real strings run to a few KB.'],
  gpp: ['string-token', 4096, 'IAB GPP string; bounded like other consent strings.'],
  tmpx: ['string-token', 4096, 'Opaque exposure token.'],
  embedding: ['string-blob', 65536, 'Encoded embedding vector.'],
  phone: ['string-code', 30, 'Matches the phone fields already bounded at 30.'],
  street: ['string-id', 200, 'Matches street fields already bounded at 200.'],
  city: ['string-id', 100, 'City name.'],
  state: ['string-id', 100, 'State or region name.'],
  tagline: ['string-id', 255, 'One-line marketing text.'],
  subtitle: ['string-id', 255, 'One-line marketing text.'],
  badge: ['string-id', 255, 'One-line marketing text.'],
  alt: ['string-text', 2000, 'Alternative text for assets, like other prose.'],
  price: ['string-code', 64, 'Formatted price for display.'],
  original_price: ['string-code', 64, 'Formatted price for display.'],
  price_hint: ['string-code', 64, 'Formatted price for display.'],
  locator: ['string-url', 2048, 'Locator, bounded like other URL-shaped values.'],
  line1: ['string-id', 200, 'Street line; matches street fields already bounded at 200.'],
  reach_methodology: ['string-text', 2000, 'Human-readable methodology, like other prose.'],
  position_delivered: ['string-id', 255, 'Short free-form position label.'],
  season: ['string-code', 64, 'Season identifier.'],
  installment_number: ['string-code', 64, 'Installment number within a season.'],
  collections_version: ['string-id', 255, 'Opaque version token; its length is the issuer\'s choice.'],
  if_collections_version: ['string-id', 255, 'Echo of an opaque version token.'],
  governance_context: ['string-token', 4096, 'Signed governance context (a JWS); matches the 4,096 already on every request that carries it.'],
  governance_contexts: ['string-token', 4096, 'Signed governance contexts (JWS); matches the 4,096 already on every request that carries one.'],
  accrediting_body: ['string-id', 255, 'Name of an accrediting body.'],
  canonical_utf8_base64: ['string-blob', 1048576, 'Base64 of a canonical document; 1 MiB matches the markup ceiling.'],
  creative_data: ['string-blob', 1048576, 'Inline creative data; 1 MiB matches the markup ceiling.'],
  intent: ['string-id', 255, 'Short intent label.'],
  action: ['string-id', 255, 'Action name.'],
  value: ['string-id', 255, 'Scalar value; 255 is the repository default for short values.'],
};

const singular = name => name.replace(/_(include|exclude|evaluated|supported|allowed)$/, '').replace(/ies$/, 'y').replace(/(ches|shes|sses)$/, m => m.slice(0, -2)).replace(/s$/, '');

function proposeString(node, pointer, description) {
  const name = nameOf(pointer);
  if (STRING_OVERRIDES[name]) {
    const [tier, limit, rationale] = STRING_OVERRIDES[name];
    return { tier, limit, rationale };
  }
  if (/ISO 8601 duration|IETF BCP 47|ISO 4217|ISO 3166|IANA time ?zone/i.test(description || '')) {
    return { tier: 'string-code', limit: 64, rationale: 'Standard short code or duration (ISO 8601, BCP 47, ISO 4217/3166, IANA): 64.' };
  }
  const isItem = /\/items$/.test(pointer);
  const candidates = isItem ? [singular(name), name] : [name];
  for (const candidate of candidates) {
    for (const [re, tier, limit, rationale] of STRING_RULES) {
      if (re.test(candidate)) return { tier, limit, rationale };
    }
  }
  if (typeof node.pattern === 'string') return { tier: 'string-id', limit: 255, rationale: 'Pattern-constrained but unbounded value; 255 is the repository default.' };
  return { tier: 'string-generic', limit: 500, rationale: TIERS['string-generic'] };
}

// ---------------------------------------------------------------------------
// Inline property and collection lists
// ---------------------------------------------------------------------------

// Arrays that carry a property or collection list inline. Matching is by field
// name because the same item shapes (domains, ids) also appear in fields that
// are not lists passed between agents (asset requirements, tag vocabularies).
const INLINE_LIST_NAMES = {
  property: /^(properties|publisher_properties|property_ids|property_tags|base_properties|publisher_domains|data_provider_domains|revoked_publisher_domains|publishers|removed_from_publishers|applies_to_property_ids|applies_to_property_tags)$/,
  collection: /^(collections|base_collections)$/,
};

// Where the inline list sits decides what moving it out of band means.
function inlineCarriage(file, side) {
  if (/^(adagents\.json|brand\.json|aao\/|core\/registry-event\.json)/.test(file)) return 'document';
  if (/(^|\/)((create|update)-(property|collection)-list-request|(property|collection)-list|base-(property|collection)-source|(property|collection)-list-filters|get-(property|collection)-list-response)\.json$/.test(file)) return 'list-authoring';
  if (/(^|\/)(publisher-property-selector|collection-selection|collection-selector)\.json$/.test(file)) return 'selector';
  return side === 'request' ? 'request-field' : 'response-field';
}

// Direct identifier enumerations, which the name rules above cannot tell from
// the identifiers of a single property.
const INLINE_LIST_FILE_FIELDS = {
  'property/base-property-source.json#identifiers': 'property',
  'property/property-list-filters.json#exclude_identifiers': 'property',
  'collection/base-collection-source.json#identifiers': 'collection',
  'collection/collection-list-filters.json#exclude_distribution_ids': 'collection',
};

// The resolved page of a list read by reference is the by-reference data plane, not an inline list.
const INLINE_LIST_EXEMPT = new Set(['collection/get-collection-list-response.json#collections']);

function inlineListKind(node, file, pointer) {
  if (!typeIncludes(node, 'array')) return null;
  const name = nameOf(pointer);
  if (INLINE_LIST_EXEMPT.has(`${file}#${name}`)) return null;
  if (INLINE_LIST_FILE_FIELDS[`${file}#${name}`]) return INLINE_LIST_FILE_FIELDS[`${file}#${name}`];
  for (const [kind, re] of Object.entries(INLINE_LIST_NAMES)) if (re.test(name)) return kind;
  return null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function loadDocs(dir) {
  const docs = new Map();
  if (!fs.existsSync(dir)) return docs;
  for (const file of listJson(dir)) {
    try {
      docs.set(file, JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  }
  return docs;
}

function build({ sourceDir = SOURCE_DIR, distDir = DIST_DIR } = {}) {
  const docs = loadDocs(sourceDir);
  const lastStableDocs = loadDocs(path.join(distDir, LAST_STABLE));
  const { reached, unresolved } = traceSides(docs);
  const inbound = buildInboundIndex(docs);
  const wireMemo = new Map();
  // A node reachable from a file another workstream owns shares that file's size budget,
  // so a bound on it changes the owner's documented figures.
  const ownedKeys = new Map();
  for (const [root, owner] of Object.entries(OWNED_ELSEWHERE)) {
    for (const key of reachableFrom(docs, root)) if (!ownedKeys.has(key)) ownedKeys.set(key, owner);
  }
  const ownerOf = (file, pointer) => ownedKeys.get(`${file}#${pointer}`);

  const entries = [];
  const inline = [];
  const skipped = { array: 0, string: {} };
  const unboundedUri = [];
  const files = [...docs.keys()].sort();

  for (const file of files) {
    walkSchemas(docs.get(file), '', (node, pointer, ancestors) => {
      const sides = reached.get(`${file}#${pointer}`);
      const side = sides ? (sides.has('request') && sides.has('response') ? 'both' : sides.has('request') ? 'request' : 'response') : 'other';
      const stab = stabilityOf(file, pointer, ancestors, node, lastStableDocs, inbound, wireMemo);
      const parent = ancestors[ancestors.length - 1];
      const siblingProps = parent && parent.properties ? Object.keys(parent.properties) : [];
      const grand = ancestors[ancestors.length - 2];

      if (typeIncludes(node, 'array')) {
        const kind = inlineListKind(node, file, pointer);
        if (kind) {
          inline.push({
            file,
            pointer,
            list_kind: kind,
            carriage: inlineCarriage(file, side),
            side,
            stability: stab.stability,
            bounded: typeof node.maxItems === 'number',
            max_items: typeof node.maxItems === 'number' ? node.maxItems : null,
          });
        }
        if (typeof node.maxItems === 'number') {
          skipped.array++;
          return;
        }
        const paged = siblingProps.includes('pagination') || (grand && grand.properties && Object.keys(grand.properties).includes('pagination'));
        const proposal = proposeArray(node, file, pointer, side, docs, paged && side !== 'request');
        entries.push({
          file,
          pointer,
          kind: 'array',
          property: nameOf(pointer),
          side,
          stability: stab.stability,
          added_in_3_3: stab.markedNew || undefined,
          newness_derived_from_refs: stab.derived || undefined,
          in_last_stable: stab.inLastStable,
          marker_conflict: stab.markerConflict || undefined,
          items: typeof node.items === 'object' && node.items ? (node.items.$ref ? `$ref ${node.items.$ref}` : node.items.type || 'schema') : 'untyped',
          proposed_limit: kind ? null : proposal.limit,
          tier: kind ? 'inline-property-list' : proposal.tier,
          rationale: kind ? 'Property/collection list carried inline; the WG rule is that such lists are passed by reference (agent_url + list_id).' : proposal.rationale,
          action: actionFor(kind, stab.stability, ownerOf(file, pointer), file, pointer, node),
        });
      } else if (typeIncludes(node, 'string')) {
        const reason = stringSkipReason(node);
        if (reason === 'format:uri' && typeof node.maxLength !== 'number') unboundedUri.push(`${file}#${pointer}`);
        if (reason) {
          skipped.string[reason] = (skipped.string[reason] || 0) + 1;
          return;
        }
        const proposal = proposeString(node, pointer, node.description);
        entries.push({
          file,
          pointer,
          kind: 'string',
          property: nameOf(pointer),
          side,
          stability: stab.stability,
          added_in_3_3: stab.markedNew || undefined,
          newness_derived_from_refs: stab.derived || undefined,
          in_last_stable: stab.inLastStable,
          marker_conflict: stab.markerConflict || undefined,
          ...(node.format ? { format: node.format } : {}),
          ...(node.pattern ? { pattern: node.pattern } : {}),
          proposed_limit: proposal.limit,
          tier: proposal.tier,
          rationale: proposal.rationale,
          action: actionFor(null, stab.stability, ownerOf(file, pointer), file, pointer, node),
        });
      }
    });
  }

  const summary = summarize(entries, inline);
  return {
    meta: {
      schema_version: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version,
      last_stable_release: LAST_STABLE,
      source_files: files.length,
      already_bounded_arrays: skipped.array,
      skipped_strings: skipped.string,
      unbounded_uri_strings: unboundedUri.length,
      unresolved_refs: [...unresolved].sort(),
      ordering: 'file, then pointer',
    },
    tiers: TIERS,
    summary,
    inline_property_lists: inline,
    entries,
    unbounded_uri_strings: unboundedUri.sort(),
  };
}

function summarize(entries, inline) {
  const count = (list, keyFn) => {
    const out = {};
    for (const e of list) {
      const k = keyFn(e);
      out[k] = (out[k] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const byKind = {};
  for (const kind of ['array', 'string']) {
    const subset = entries.filter(e => e.kind === kind);
    byKind[kind] = {
      total: subset.length,
      files: new Set(subset.map(e => e.file)).size,
      by_stability: count(subset, e => e.stability),
      by_side: count(subset, e => e.side),
      by_stability_and_side: count(subset, e => `${e.stability}/${e.side}`),
      by_tier: count(subset, e => e.tier),
      by_action: count(subset, e => e.action),
    };
  }
  return {
    ...byKind,
    inline_property_lists: { total: inline.length, by_kind: count(inline, e => e.list_kind), by_stability: count(inline, e => e.stability), unbounded: inline.filter(e => !e.bounded).length },
  };
}

function render(inventory) {
  // One entry per line keeps the committed file reviewable and diffable.
  const { entries, inline_property_lists: inline, ...rest } = inventory;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  const lines = (list) => list.map(e => `    ${JSON.stringify(e)}`).join(',\n');
  return `${head},\n  "inline_property_lists": [\n${lines(inline)}\n  ],\n  "entries": [\n${lines(entries)}\n  ]\n}\n`;
}

function printSummary(inventory) {
  const s = inventory.summary;
  const out = [];
  for (const kind of ['array', 'string']) {
    const k = s[kind];
    out.push(`Unbounded ${kind}s: ${k.total} in ${k.files} files`);
    out.push(`  by stability: ${JSON.stringify(k.by_stability)}`);
    out.push(`  by side:      ${JSON.stringify(k.by_side)}`);
    out.push(`  by action:    ${JSON.stringify(k.by_action)}`);
  }
  out.push(`Inline property/collection lists: ${s.inline_property_lists.total} (${s.inline_property_lists.unbounded} unbounded) ${JSON.stringify(s.inline_property_lists.by_kind)}`);
  out.push(`Unbounded uri-format strings (skipped by the task rules, not length-bounded): ${inventory.meta.unbounded_uri_strings}`);
  const conflicts = inventory.entries.filter(e => e.marker_conflict).length;
  if (conflicts) out.push(`x-added-in markers that conflict with ${LAST_STABLE} (treated as stable): ${conflicts}`);
  process.stdout.write(out.join('\n') + '\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const inventory = build();
  if (args.has('--json')) {
    process.stdout.write(render(inventory));
    return;
  }
  if (args.has('--write')) {
    fs.writeFileSync(INVENTORY_PATH, render(inventory));
    printSummary(inventory);
    return;
  }
  if (args.has('--check') || args.has('--check-unreleased')) {
    let failed = false;
    if (args.has('--check')) {
      const committed = fs.existsSync(INVENTORY_PATH) ? fs.readFileSync(INVENTORY_PATH, 'utf8') : '';
      if (committed !== render(inventory)) {
        console.error('scripts/schema-bounds-inventory.json is stale. Run: node scripts/audit-schema-bounds.cjs --write');
        failed = true;
      }
    }
    if (args.has('--check-unreleased')) {
      const open = inventory.entries.filter(e => e.action === 'apply in 3.3');
      if (open.length) {
        console.error(`${open.length} unbounded array(s) or string(s) are new in 3.3 or experimental. Add maxItems/maxLength:`);
        for (const e of open.slice(0, 50)) console.error(`  ${e.file}#${e.pointer} (${e.kind}, ${e.stability}) -> ${e.proposed_limit}`);
        failed = true;
      }
    }
    if (failed) process.exit(1);
    console.log('schema bounds inventory ok');
    return;
  }
  printSummary(inventory);
}

if (require.main === module) main();

module.exports = { build, render, isBoundedPattern };
