'use strict';

/**
 * Corpus differential: validate real payloads against the base and head
 * schemas with the repo's Ajv configuration and report every payload whose
 * verdict changes.
 *
 * Bound instances (validated against the schema they name):
 *   schema-example       `examples` entries inside schemas (both refs), against
 *                        the subschema that holds them
 *   docs                 ```json blocks in docs/ that carry a `$schema`
 *                        (macros replaced and `$schema` removed, as
 *                        tests/json-schema-validation.test.cjs does)
 *   storyboard-request   storyboard `sample_request` against `schema_ref`,
 *                        substitutions replaced as
 *                        scripts/lint-storyboard-sample-request-schema.cjs does
 *   storyboard-response  storyboard `sample_response` against `response_schema_ref`
 *   example-file         static/examples fixtures with a known schema
 *
 * Probe values (no declared schema): every distinct JSON value in the
 * compliance test vectors, the storyboard and test-kit files, static/test-vectors,
 * and static/examples, validated against each changed site (the subschema
 * pair where a difference sits). A probe hit is a real value that the changed
 * constraint treats differently.
 */

const path = require('node:path');
const yaml = require('js-yaml');
const { createAjv } = require('./ajv.cjs');
const { git, readBlobs, isRootFile } = require('./tree.cjs');
const { stableStringify, escapePointer } = require('./json.cjs');

const { SUBSTITUTION_RE } = require('../../lint-storyboard-sample-request-schema.cjs');

const PUBLISHED = /^https:\/\/adcontextprotocol\.org\/schemas\/(.+)$/;
const SEMVER_SEGMENT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

class TreeValidator {
  /** `lazy` loads only the documents a compiled root reaches (cheap to create). */
  constructor(tree, { lazy = false } = {}) {
    this.tree = tree;
    this.cache = new Map();
    this.problems = [];
    this.ajv = createAjv({
      allErrors: false,
      loadSchema: async (uri) => {
        const m = PUBLISHED.exec(uri);
        const rel = m ? m[1] : uri.replace(/^\/schemas\//, '');
        const first = rel.split('/')[0];
        const doc = SEMVER_SEGMENT.test(first) ? tree.readDist(rel) : tree.files.get(rel.replace(/^latest\//, ''));
        if (!doc) throw new Error(`cannot load ${uri}`);
        return doc;
      },
    });
    for (const [rel, doc] of lazy ? [] : tree.files) {
      if (!isRootFile(rel)) continue;
      try {
        this.ajv.addSchema(doc, `/schemas/${rel}`);
      } catch (err) {
        this.problems.push(`${rel}: ${err.message}`);
      }
    }
  }

  /** A validate function for `rel#ptr`, or { error }. */
  async get(location) {
    if (this.cache.has(location)) return this.cache.get(location);
    const [rel, ptr = ''] = location.split('#');
    let out;
    if (!this.tree.files.has(rel)) out = { error: 'missing' };
    else {
      const frag = ptr ? `#${ptr.split('/').map(s => encodeURIComponent(s)).join('/')}` : '';
      try {
        out = await this.ajv.compileAsync({ $ref: `/schemas/${rel}${frag}` });
      } catch (err) {
        out = { error: err.message };
      }
    }
    this.cache.set(location, out);
    return out;
  }
}

function verdict(validate, instance) {
  if (typeof validate !== 'function') return { v: 'n/a', error: validate.error };
  const ok = validate(instance);
  if (ok) return { v: 'valid' };
  const e = validate.errors && validate.errors[0];
  return { v: 'invalid', error: e ? `${e.instancePath || '/'} ${e.message}` : 'invalid' };
}

const EXAMPLE_WRAPPER_KEYS = new Set(['data', 'description', 'title', 'name', 'comment', '$comment']);

/** Every `examples` array in schema positions of one schema document. */
function schemaExamples(rel, doc, out) {
  const SUB_SINGLE = ['additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'];
  const SUB_MAP = ['properties', 'patternProperties', 'definitions', '$defs', 'dependencies'];
  const walk = (node, ptr) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (Array.isArray(node.examples)) {
      node.examples.forEach((value, i) => {
        // The repo's convention wraps a payload as { description, data }.
        const wrapped = value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'data')
          && Object.keys(value).every(k => EXAMPLE_WRAPPER_KEYS.has(k));
        out.push({ source: 'schema-example', schema: `${rel}#${ptr}`, label: `${rel}#${ptr}/examples/${i}${wrapped ? '/data' : ''}`, instance: wrapped ? value.data : value });
      });
    }
    for (const k of SUB_SINGLE) if (node[k]) walk(node[k], `${ptr}/${k}`);
    if (node.items) {
      if (Array.isArray(node.items)) node.items.forEach((s, i) => walk(s, `${ptr}/items/${i}`));
      else walk(node.items, `${ptr}/items`);
    }
    for (const k of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(node[k])) node[k].forEach((s, i) => walk(s, `${ptr}/${k}/${i}`));
    for (const k of SUB_MAP) {
      if (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) {
        for (const [name, s] of Object.entries(node[k])) walk(s, `${ptr}/${k}/${escapePointer(name)}`);
      }
    }
  };
  walk(doc, '');
}

/** Lists and reads repo files at a commit under the given prefixes. */
function readRepoFiles(repo, commit, prefixes, filter) {
  const listing = git(repo, ['ls-tree', '-r', '-z', commit, '--', ...prefixes]).toString('utf8');
  const entries = [];
  for (const line of listing.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [, type, sha] = line.slice(0, tab).split(' ');
    const file = line.slice(tab + 1);
    if (type === 'blob' && filter(file)) entries.push({ file, sha });
  }
  const blobs = readBlobs(repo, [...new Set(entries.map(e => e.sha))]);
  return entries.map(e => ({ file: e.file, text: blobs.get(e.sha).toString('utf8') }));
}

function schemaUriToRel(uri) {
  return uri
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/schemas\/latest\//, '/')
    .replace(/^\/schemas\/v?\d+(?:\.\d+)*(?:-[^/]+)?\//, '/')
    .replace(/^\/schemas\//, '/')
    .replace(/^\/+/, '')
    .split('#')[0];
}

function docsBlocks(file, text, out) {
  const { replaceMacros } = require('../../../tests/json-schema-validation.test.cjs');
  const re = /```json[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (/\[\.\.\.\]|\{\.\.\.\}|\.\.\./.test(body)) continue;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.$schema !== 'string') continue;
    const instance = replaceMacros(JSON.parse(JSON.stringify(parsed)));
    delete instance.$schema;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ source: 'docs', schema: `${schemaUriToRel(parsed.$schema)}#`, label: `${file}:${line}`, instance });
  }
}

/** Adds the storyboard's bound samples to `out`; returns the JSON pointers of those samples. */
function storyboardSamples(file, doc, out, notes) {
  const lint = require('../../lint-storyboard-sample-request-schema.cjs');
  const phases = Array.isArray(doc && doc.phases) ? doc.phases : [];
  const boundPointers = [];
  phases.forEach((phase, pi) => {
    (phase && Array.isArray(phase.steps) ? phase.steps : []).forEach((step, si) => {
      if (!step || typeof step !== 'object') return;
      const stepPtr = `/phases/${pi}/steps/${si}`;
      const where = `${file} :: ${phase.id}/${step.id}`;
      if (typeof step.schema_ref === 'string' && !step.schema_ref.startsWith('$test_kit.') && step.sample_request && typeof step.sample_request === 'object') {
        const rel = schemaUriToRel(step.schema_ref.startsWith('/schemas/') ? step.schema_ref : `/schemas/${step.schema_ref}`);
        let payloads;
        try {
          const schema = lint.loadSchema(step.schema_ref);
          payloads = schema ? lint.normalizeStoryboardSampleRequests(doc, step, schema) : [step.sample_request];
        } catch (err) {
          notes.push(`${where}: substitution normalization failed (${err.message}); validated the raw sample`);
          payloads = [step.sample_request];
        }
        const negative = lint.isNegativeStep(step);
        payloads.forEach((p, i) => out.push({ source: 'storyboard-request', schema: `${rel}#`, label: payloads.length > 1 ? `${where} [${i}]` : where, instance: p, negative }));
        boundPointers.push(`${stepPtr}/sample_request`);
      }
      if (typeof step.response_schema_ref === 'string' && !step.response_schema_ref.startsWith('$test_kit.') && step.sample_response && typeof step.sample_response === 'object') {
        const rel = schemaUriToRel(step.response_schema_ref.startsWith('/schemas/') ? step.response_schema_ref : `/schemas/${step.response_schema_ref}`);
        out.push({ source: 'storyboard-response', schema: `${rel}#`, label: where, instance: step.sample_response });
        boundPointers.push(`${stepPtr}/sample_response`);
      }
    });
  });
  return boundPointers;
}

const EXAMPLE_FILE_BINDINGS = [
  [/^static\/examples\/products\/canonical\/[^/]+\.json$/, 'core/product.json'],
  [/^static\/examples\/get_products_responses\/canonical\/[^/]+\.json$/, 'media-buy/get-products-response.json'],
  [/^static\/examples\/adagents\/.+\.json$/, 'adagents.json'],
  [/^static\/examples\/brand-json\/[^/]+\.json$/, 'brand.json'],
];

const PROBE_PREFIXES = ['static/compliance/source/', 'static/test-vectors/', 'static/examples/'];
const SOURCES = {
  included: [
    'schema `examples` (both refs), against the enclosing subschema',
    'docs/**/*.md(x) ```json blocks with a `$schema`',
    'storyboard sample_request (schema_ref) and sample_response (response_schema_ref) in static/compliance/source/**/*.yaml',
    'static/examples/{products/canonical, get_products_responses/canonical, adagents, brand-json}',
    'unbound probe values (heuristic, never fail the check): every distinct JSON value outside the bound samples in static/compliance/source/** (test vectors, storyboard fixtures, test kits), static/test-vectors/**, static/examples/**, probed against a changed site only when found under the same (parent property, property) pair that the roots reach the site under',
  ],
  excluded: [
    'steps whose schema_ref is `$test_kit.*`: the schema is chosen at run time',
    'docs blocks with `...` placeholders or invalid JSON, as tests/json-schema-validation.test.cjs skips them',
    '*.schema.json files under static/compliance/source and static/test-vectors: they are schemas for the vectors, not payloads',
    'dist/: release records, not authored payloads',
  ],
};

/** Collects bound instances and probe values from the repo at a commit. */
function collectCorpus({ repo, commit, baseTree, headTree }) {
  const bound = [];
  const notes = [];
  for (const tree of [baseTree, headTree]) {
    for (const [rel, doc] of tree.files) if (isRootFile(rel)) schemaExamples(rel, doc, bound);
  }
  const probeValues = new Map();
  if (!repo || !commit) return dedupeBound(bound, probeValues, notes);

  const files = readRepoFiles(repo, commit, ['docs/', ...PROBE_PREFIXES], (f) =>
    (f.startsWith('docs/') && /\.mdx?$/.test(f)) ||
    (PROBE_PREFIXES.some(p => f.startsWith(p)) && /\.(json|ya?ml)$/.test(f) && !/\.schema\.json$/.test(f)));
  for (const { file, text } of files) {
    if (file.startsWith('docs/')) {
      docsBlocks(file, text, bound);
      continue;
    }
    let doc;
    try {
      doc = file.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
    } catch (err) {
      notes.push(`${file}: not parsed (${err.message.split('\n')[0]})`);
      continue;
    }
    let boundPointers = [];
    if (/\.ya?ml$/.test(file) && file.startsWith('static/compliance/source/')) boundPointers = storyboardSamples(file, doc, bound, notes);
    const binding = EXAMPLE_FILE_BINDINGS.find(([re]) => re.test(file));
    if (binding) {
      bound.push({ source: 'example-file', schema: `${binding[1]}#`, label: file, instance: doc });
      boundPointers = [''];
    }
    collectValues(doc, file, '', probeValues, { boundPointers });
  }
  return dedupeBound(bound, probeValues, notes);
}

/**
 * Every distinct value in a document outside its bound samples, with the
 * (parent property, property) pairs it was found under, written
 * "parent/property" (array elements take their array's names; a top-level
 * property has an empty parent). Values inside a bound sample are left out:
 * the bound differential already validates them in their real context.
 */
function collectValues(value, file, ptr, out, ctx, prop = null, parent = null) {
  if (ctx.boundPointers.some(b => ptr === b || ptr.startsWith(`${b}/`) || b === '')) return;
  const key = stableStringify(value);
  if (prop !== null) {
    if (!out.has(key)) out.set(key, { value, label: `${file}#${ptr}`, props: new Set() });
    out.get(key).props.add(`${parent ?? ''}/${prop}`);
  }
  if (Array.isArray(value)) value.forEach((v, i) => collectValues(v, file, `${ptr}/${i}`, out, ctx, prop, parent));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectValues(v, file, `${ptr}/${escapePointer(k)}`, out, ctx, k, prop);
  }
}

/** Probe values from in-memory documents (directory mode). */
function probeValues(docs) {
  const out = new Map();
  for (const { label, doc } of docs) collectValues(doc, label, '', out, { boundPointers: [] });
  return [...out.values()];
}

function dedupeBound(bound, probeValues, notes) {
  const seen = new Set();
  const out = [];
  for (const b of bound) {
    const key = `${b.source}|${b.schema}|${stableStringify(b.instance)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return { bound: out, probes: [...probeValues.values()], notes };
}

/**
 * Runs the differential. `changedRoots` limits bound instances to roots that
 * differ (all roots when `all` is set); `sites` are { base, head } source
 * locations to probe.
 */
async function differential({ baseTree, headTree, corpus, changedRoots, sites, all = false, maxProbeSamples = 5, validators }) {
  const t0 = Date.now();
  const baseV = validators ? validators.base : new TreeValidator(baseTree);
  const headV = validators ? validators.head : new TreeValidator(headTree);
  const changed = new Set(changedRoots);
  const selected = corpus.bound.filter(b => all || changed.has(b.schema.split('#')[0]));
  const changes = [];
  const unpaired = [];
  const counts = {};
  for (const item of selected) {
    const [va, vb] = [await baseV.get(item.schema), await headV.get(item.schema)];
    const a = verdict(va, item.instance);
    const b = verdict(vb, item.instance);
    const c = counts[item.source] || (counts[item.source] = { checked: 0, valid_both: 0, invalid_both: 0, changed: 0, unpaired: 0 });
    c.checked++;
    if (a.v === 'n/a' || b.v === 'n/a') {
      c.unpaired++;
      unpaired.push({ source: item.source, label: item.label, schema: item.schema, base: a, head: b });
      continue;
    }
    if (a.v !== b.v) {
      c.changed++;
      changes.push({ source: item.source, label: item.label, schema: item.schema, negative: item.negative || undefined, base: a, head: b });
    } else if (a.v === 'valid') c.valid_both++;
    else c.invalid_both++;
  }

  // Probe hits, merged per head site (one head node can pair with several
  // base locations when the base inlined it in several places).
  const byHead = new Map();
  const skipped = [];
  let probed = 0;
  for (const site of sites) {
    const [va, vb] = [await baseV.get(site.base), await headV.get(site.head)];
    if (typeof va !== 'function' || typeof vb !== 'function') {
      skipped.push({ site: { base: site.base, head: site.head }, skipped: (va.error || vb.error) });
      continue;
    }
    if (!byHead.has(site.head)) byHead.set(site.head, { site: site.head, props: new Set(), values: new Map() });
    const h = byHead.get(site.head);
    for (const p of site.props) h.props.add(p);
    for (const p of corpus.probes) {
      if (![...p.props].some(x => site.props.has(x))) continue;
      // Storyboard substitutions ($context.x, {{runner.y}}) are filled at run time.
      if (typeof p.value === 'string' && SUBSTITUTION_RE.test(p.value)) continue;
      probed++;
      const a = va(p.value);
      const b = vb(p.value);
      if (a === b) continue;
      const key = stableStringify(p.value);
      if (!h.values.has(key)) h.values.set(key, { value: p.value, found_at: p.label, base: a ? 'valid' : 'invalid', head: b ? 'valid' : 'invalid' });
    }
  }
  const probeHits = [...byHead.values()].filter(h => h.values.size).map(h => ({
    site: h.site, under: [...h.props].sort(), hits: h.values.size, samples: [...h.values.values()].slice(0, maxProbeSamples),
  }));
  return {
    sources: SOURCES,
    bound_total: corpus.bound.length,
    bound_checked: selected.length,
    probe_values: corpus.probes.length,
    sites_probed: sites.length,
    counts,
    changes,
    unpaired,
    probe_checks: probed,
    probe_hits: probeHits,
    probe_skipped: skipped,
    notes: corpus.notes,
    validator_problems: [...baseV.problems.map(p => `base: ${p}`), ...headV.problems.map(p => `head: ${p}`)],
    ms: Date.now() - t0,
  };
}

/** Probe sites from difference entries: distinct (base, head) source locations. */
/**
 * The "parent/property" pair a schema pointer reaches its node under (empty
 * parent for a top-level property), or null when the path passes through
 * additionalProperties, patternProperties, or propertyNames, or names no
 * property.
 */
function propertyName(entry) {
  const segs = entry.pointer.split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  // A presence entry (…/properties/x) sits on the parent node.
  if (['properties', 'patternProperties', 'dependencies'].includes(entry.keyword)) segs.splice(-2);
  let names = [];
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === 'properties') names.push(segs[++i]);
    else if (['additionalProperties', 'patternProperties', 'propertyNames'].includes(segs[i])) names = [null];
  }
  const last = names[names.length - 1];
  if (last === undefined || last === null) return null;
  const parent = names.length > 1 ? names[names.length - 2] : '';
  return parent === null ? null : `${parent}/${last}`;
}

/**
 * Probe sites from difference entries: distinct (base, head) source locations,
 * each with the property names the roots reach it under. Only corpus values
 * found under one of those names are probed, so prose and unrelated IDs do
 * not count as payloads of an ID schema.
 */
function sitesFromEntries(entries) {
  const out = new Map();
  for (const e of entries) {
    if (!e.base_location || !e.head_location) continue;
    if (e.base_location.startsWith('dist/') || e.head_location.startsWith('dist/')) continue;
    const key = `${e.base_location} ${e.head_location}`;
    if (!out.has(key)) out.set(key, { base: e.base_location, head: e.head_location, props: new Set() });
    const name = propertyName(e);
    if (name !== null) out.get(key).props.add(name);
  }
  return [...out.values()].filter(s => s.props.size);
}

module.exports = { collectCorpus, differential, sitesFromEntries, probeValues, TreeValidator, verdict, SOURCES };
