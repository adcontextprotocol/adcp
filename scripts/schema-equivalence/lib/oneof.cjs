'use strict';

/**
 * The `oneof` check: for every `oneOf` the published roots reach (through any
 * number of `$ref`s), one of three results.
 *
 *   P  proved: every branch pair is disjoint under the context where the
 *      `oneOf` is evaluated (lib/disjoint.cjs, lib/context.cjs), the `oneOf`
 *      has one branch, or Ajv's `discriminator` selects one branch per object
 *      and lets non-objects pass, so an overlap can never reject a payload.
 *   W  witnessed: a payload matches two or more branches, and Ajv, with the
 *      repo options and every schema registered, rejects it at the `oneOf`
 *      with that single `oneOf` error. Each branch Ajv names also accepts the
 *      payload on its own.
 *   U  undecided: neither.
 *
 * Witness candidates come from the branch schemas: instances synthesized for
 * each branch (guided through the `oneOf`, from the branch alone, with a few
 * enum choices, and with one optional property at a time), every pair of them
 * merged in both orders, and plain values of every JSON type. A witness is
 * minimized by deleting keys while it stays a witness.
 */

const { Graph, readDoc } = require('./graph.cjs');
const { isRootFile } = require('./tree.cjs');
const { getPointer, stableStringify, escapePointer } = require('./json.cjs');
const { proveDisjoint, facts, contextOf } = require('./disjoint.cjs');
const { computeContexts, graphRootIds } = require('./context.cjs');
const { ajvDiscriminatorMapping } = require('./rewrite.cjs');
const { synth } = require('./witness.cjs');
const { TreeValidator } = require('./corpus.cjs');
const { refTarget } = require('./graph.cjs');

const SIDE = 'head';
const GENERIC = [null, true, false, 0, 1, -1, 1.5, '', 'a', 'https://example.com/x', [], [1], ['a'], {}];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const failed = v => typeof v === 'symbol';

function docRel(doc) {
  return doc.slice(doc.indexOf(':') + 1);
}

function label(doc, ptr) {
  return `${doc.startsWith('dist:') ? 'dist/schemas/' : ''}${docRel(doc)}#${ptr}/oneOf`;
}

/** Every reachable location whose raw schema has a `oneOf` array. */
function sitesOf(graph, tree) {
  const out = [];
  const prefix = `${SIDE}|`;
  for (const key of graph.locNode.keys()) {
    if (!key.startsWith(prefix)) continue;
    const hash = key.indexOf('#');
    const doc = key.slice(prefix.length, hash);
    const ptr = key.slice(hash + 1);
    const raw = getPointer(readDoc(tree, doc), ptr);
    if (isObj(raw) && Array.isArray(raw.oneOf)) out.push({ doc, ptr, raw, key });
  }
  return out.sort((a, b) => label(a.doc, a.ptr).localeCompare(label(b.doc, b.ptr)));
}

/** The join of two { types, required } contexts. */
function joinCtx(a, b) {
  if (!a) return b;
  return {
    types: a.types === null || b.types === null ? null : new Set([...a.types, ...b.types]),
    required: new Set([...a.required].filter(k => b.required.has(k))),
  };
}

/**
 * The context the `oneOf` at a site is evaluated under: for every reachable
 * schema object that holds this `oneOf` (the location's own object, a merged
 * object that took its `oneOf`, a property-name copy), its inherited context
 * met with its own facts; joined over all of them.
 */
function siteContext(graph, contexts, holders, site) {
  let ctx = null;
  for (const id of holders) {
    const inherited = contexts.get(id);
    if (!inherited) continue;
    const own = contextOf(graph, [graph.nodes[id]]);
    const types = inherited.types === null ? own.types : own.types === null ? inherited.types : new Set([...own.types].filter(t => inherited.types.has(t)));
    ctx = joinCtx(ctx, { types, required: new Set([...own.required, ...inherited.required]) });
  }
  if (ctx) return ctx;
  // No reachable holder: the location's own keywords still hold where Ajv evaluates it.
  const f = facts(graph, graph.locNode.get(site.key));
  return { types: f.types, required: f.required };
}

function derefRaw(tree, doc, s, depth = 0) {
  if (depth > 16 || !isObj(s) || typeof s.$ref !== 'string') return { doc, schema: s };
  const t = refTarget(doc, s.$ref);
  const target = t && getPointer(readDoc(tree, t.doc) || {}, t.ptr);
  return target === undefined ? { doc, schema: s } : derefRaw(tree, t.doc, target, depth + 1);
}

function propsOf(tree, doc, s, depth = 0, out = {}) {
  const { doc: d, schema } = derefRaw(tree, doc, s);
  if (!isObj(schema) || depth > 6) return out;
  if (isObj(schema.properties)) for (const [k, v] of Object.entries(schema.properties)) if (!(k in out)) out[k] = { doc: d, s: v };
  for (const m of Array.isArray(schema.allOf) ? schema.allOf : []) propsOf(tree, d, m, depth + 1, out);
  return out;
}

function merge(a, b) {
  if (isObj(a) && isObj(b)) {
    const out = { ...b };
    for (const [k, v] of Object.entries(a)) out[k] = k in b ? merge(v, b[k]) : v;
    return out;
  }
  return a;
}

function branchInstances(tree, site, i) {
  const out = [];
  const b = site.raw.oneOf[i];
  const ctxProps = isObj(site.raw.properties) ? site.raw.properties : {};
  for (let c = 0; c < 3; c++) {
    const g = synth(tree, site.doc, site.raw, ['oneOf', String(i)], 0, c);
    if (!failed(g)) out.push(g);
    const h = synth(tree, site.doc, b, [], 0, c, ctxProps);
    if (!failed(h)) out.push(h);
  }
  // One optional property at a time on top of the first object instance.
  const baseObj = out.find(isObj);
  if (baseObj) {
    const pool = { ...propsOf(tree, site.doc, b), ...propsOf(tree, site.doc, site.raw) };
    for (const [k, { doc, s }] of Object.entries(pool).slice(0, 40)) {
      if (k in baseObj) continue;
      const v = synth(tree, doc, s, [], 0, 0);
      if (!failed(v)) out.push({ ...baseObj, [k]: v });
    }
  }
  const seen = new Set();
  return out.filter((v) => {
    const k = stableStringify(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The branches Ajv says a payload passes, when the payload's only error is this `oneOf`'s overlap error. */
function overlapRejection(validate, site, inst) {
  if (validate(inst)) return null;
  const errs = validate.errors || [];
  if (errs.length !== 1) return null;
  const e = errs[0];
  if (e.keyword !== 'oneOf' || e.instancePath !== '' || !e.params || !Array.isArray(e.params.passingSchemas)) return null;
  // Ajv names the keyword relative to an inlined target ('#/oneOf') or by the
  // target's URI ('/schemas/<rel>/oneOf', '/schemas/<rel>#<ptr>/oneOf').
  const sp = decodeURIComponent(e.schemaPath);
  const hash = sp.indexOf('#');
  const inDoc = hash >= 0 ? sp.slice(hash + 1) : sp.startsWith(`/schemas/${docRel(site.doc)}`) ? sp.slice(`/schemas/${docRel(site.doc)}`.length) : null;
  if (inDoc !== '/oneOf' && inDoc !== `${site.ptr}/oneOf`) return null;
  // The caller checks that each named branch accepts the payload on its own,
  // so two or more of them make this oneOf reject it.
  return e.params.passingSchemas.length >= 2 ? e.params.passingSchemas : null;
}

function minimize(validate, site, payload) {
  let cur = payload;
  let changed = true;
  while (changed) {
    changed = false;
    const paths = [];
    const walk = (v, path, depth) => {
      if (depth > 3) return;
      if (isObj(v)) for (const k of Object.keys(v)) { paths.push([...path, k]); walk(v[k], [...path, k], depth + 1); }
      else if (Array.isArray(v)) v.forEach((x, i) => { paths.push([...path, i]); walk(x, [...path, i], depth + 1); });
    };
    walk(cur, [], 0);
    for (const path of paths) {
      const copy = structuredClone(cur);
      let parent = copy;
      for (const step of path.slice(0, -1)) parent = parent[step];
      const last = path[path.length - 1];
      if (Array.isArray(parent)) parent.splice(last, 1);
      else delete parent[last];
      if (overlapRejection(validate, site, copy)) {
        cur = copy;
        changed = true;
        break;
      }
    }
  }
  return cur;
}

function location(site, suffix = '') {
  return `${docRel(site.doc)}#${site.ptr}${suffix}`;
}

async function searchWitness(tree, validators, site, openPairs) {
  if (!site.doc.startsWith('src:')) return { error: 'the oneOf is in a pinned dist/ schema; the witness search reads source schemas only' };
  const validate = await validators.get(location(site));
  if (typeof validate !== 'function') return { error: `Ajv cannot compile the location: ${validate.error}` };
  const inst = site.raw.oneOf.map((_, i) => branchInstances(tree, site, i));
  const found = [];
  const tryOne = (c) => {
    const passing = overlapRejection(validate, site, c);
    if (passing) found.push({ payload: c, object: isObj(c) });
  };
  for (const [i, j] of openPairs) {
    for (const a of inst[i].slice(0, 30)) {
      for (const b of inst[j].slice(0, 30)) {
        tryOne(a);
        tryOne(b);
        tryOne(merge(a, b));
        tryOne(merge(b, a));
      }
    }
  }
  for (const g of GENERIC) tryOne(g);
  // Prefer object witnesses, then the smallest.
  found.sort((x, y) => (y.object - x.object) || (stableStringify(x.payload).length - stableStringify(y.payload).length));
  for (const f of found) {
    const payload = minimize(validate, site, f.payload);
    const passing = overlapRejection(validate, site, payload);
    if (!passing) continue;
    // Each branch Ajv names must accept the payload on its own.
    let alone = true;
    for (const i of passing) {
      const v = await validators.get(location(site, `/oneOf/${i}`));
      if (typeof v !== 'function' || !v(payload)) alone = false;
    }
    if (alone) return { payload, passing };
  }
  return null;
}

/**
 * Checks every reachable `oneOf` of a schema tree. Returns
 * { sites, counts: { P, W, U }, problems }.
 */
async function checkOneOf(tree) {
  const roots = [...tree.files.keys()].filter(isRootFile).sort();
  const graph = new Graph();
  graph.addSide(SIDE, tree, roots);
  graph.finalize();
  const contexts = computeContexts(graph, graphRootIds(graph));

  // Reachable schema objects by the `oneOf` they hold; a property-name copy
  // counts for the object it copies.
  const byArray = new Map();
  const byNode = new Map();
  const add = (map, k, id) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(id);
  };
  for (const id of contexts.keys()) {
    const n = graph.nodes[id];
    if (n.kind !== 'plain' || !n.kids.oneOf) continue;
    add(byArray, n.kids.oneOf, id);
    if (n.copyOf !== undefined) add(byNode, n.copyOf, id);
  }
  // The schema object each location built, by origin (the first one wins:
  // merges and copies come later).
  const built = new Map();
  for (const n of graph.nodes) {
    if (n.kind !== 'plain' || !n.origin || n.origin.side !== SIDE || n.copyOf !== undefined) continue;
    const k = `${n.origin.doc}#${n.origin.ptr}`;
    if (!built.has(k) && (n.kids.oneOf || n.kw.discriminator !== undefined)) built.set(k, n);
  }

  const validators = new TreeValidator(tree, { allErrors: true });
  const results = [];
  for (const site of sitesOf(graph, tree)) {
    const n = site.raw.oneOf.length;
    const r = { location: label(site.doc, site.ptr), branches: n };
    results.push(r);
    if (n < 2) {
      Object.assign(r, { result: 'P', rules: ['single-branch'], proof: 'one branch' });
      continue;
    }
    const node = built.get(`${site.doc}#${site.ptr}`);
    const arr = node && node.kids.oneOf;
    const holders = [];
    if (arr) {
      for (const id of byArray.get(arr) || []) holders.push(id);
      for (const id of byArray.get(arr) || []) for (const c of byNode.get(id) || []) holders.push(c);
      for (const c of byNode.get(node.id) || []) holders.push(c);
    }
    const ctx = siteContext(graph, contexts, [...new Set(holders)], site);
    const branchIds = site.raw.oneOf.map((_, i) => graph.resolve(graph.locNode.get(`${SIDE}|${site.doc}#${site.ptr}/oneOf/${escapePointer(i)}`)).n);
    const proofs = [];
    const open = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const p = proveDisjoint(graph, branchIds[i], branchIds[j], ctx);
        if (p) proofs.push(p);
        else open.push([i, j]);
      }
    }
    if (!open.length) {
      Object.assign(r, { result: 'P', rules: [...new Set(proofs.map(p => p.rule))].sort(), proof: [...new Set(proofs.map(p => p.text))].join('; ') });
      continue;
    }
    if (site.raw.discriminator !== undefined) {
      const mapping = node && ajvDiscriminatorMapping(graph, node);
      if (mapping) {
        Object.assign(r, { result: 'P', rules: ['discriminator'], proof: `Ajv's discriminator "${mapping.tag}" checks each object against the one branch its tag selects and lets non-objects pass` });
      } else {
        Object.assign(r, { result: 'U', open, reason: 'the discriminator is one Ajv does not compile' });
      }
      continue;
    }
    const w = await searchWitness(tree, validators, site, open);
    if (w && !w.error) {
      Object.assign(r, { result: 'W', witness: w.payload, passing: w.passing });
    } else {
      Object.assign(r, { result: 'U', open, reason: w && w.error ? w.error : `${open.length} of ${n * (n - 1) / 2} branch pairs not proved disjoint, and no witness found` });
    }
  }
  const counts = { P: 0, W: 0, U: 0 };
  for (const r of results) counts[r.result]++;
  return { sites: results, counts, problems: graph.problems };
}

function oneLine(text, max) {
  const s = String(text).replace(/\r\n?|\n/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Plain text in a Markdown table cell: backslashes first, then pipes. */
function textCell(text, max = 220) {
  return oneLine(text, max).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * A code span in a Markdown table cell. Backslashes in a code span are
 * literal, and GitHub's table parser reads every `\|` as a pipe before it
 * parses the span, so only pipes get a backslash. The fence is one backtick
 * longer than any run of backticks inside.
 */
function codeCell(text, max = 220) {
  const s = oneLine(text, max).split('|').join('\\|');
  const fence = '`'.repeat(Math.max(0, ...(s.match(/`+/g) || []).map(run => run.length)) + 1);
  const pad = /^[ `]|[ `]$/.test(s) ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** A Markdown report: counts, then one table row per `oneOf` (W and U first). */
function formatOneOf(report) {
  const { counts, sites } = report;
  const lines = [];
  lines.push(`### oneOf check: ${report.label}${report.commit ? ` (${report.commit.slice(0, 12)})` : ''}`);
  lines.push('');
  lines.push(`${sites.length} reachable \`oneOf\`: **P ${counts.P}** proved disjoint, **W ${counts.W}** overlap witnessed, **U ${counts.U}** undecided.`);
  lines.push('');
  lines.push('| Result | oneOf | Detail |');
  lines.push('|---|---|---|');
  const order = { W: 0, U: 1, P: 2 };
  const sorted = [...sites].sort((a, b) => order[a.result] - order[b.result] || a.location.localeCompare(b.location));
  for (const s of sorted) {
    let detail;
    if (s.result === 'W') detail = `branches ${s.passing.join(', ')} of ${s.branches} accept ${codeCell(stableStringify(s.witness), 180)}`;
    else if (s.result === 'U') detail = textCell(s.reason);
    else detail = textCell(s.rules.join(', '));
    lines.push(`| ${s.result} | ${codeCell(s.location, 160)} | ${detail} |`);
  }
  return lines.join('\n');
}

module.exports = { checkOneOf, formatOneOf };
