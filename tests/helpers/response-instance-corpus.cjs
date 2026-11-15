'use strict';

/**
 * Every response instance the repository carries, with the schema it is
 * checked against: schema examples, `$schema`-tagged doc examples,
 * storyboard sample responses, and the compliance vectors and fixtures
 * that hold task responses.
 *
 * Each entry is `{ id, schema, data }`. `schema` is a source-relative path
 * (`media-buy/create-media-buy-response.json`). `id` names where the
 * instance lives and is stable across runs, so a test can list instances by
 * id.
 *
 * Used by tests/response-envelope-composition.test.cjs to compare every
 * instance's verdict across two schema builds.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function walk(dir, accept) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out.sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Source-relative schema path for a `$schema` URI or a storyboard ref. */
function schemaPathOf(uri) {
  if (typeof uri !== 'string') return null;
  let rel = uri.replace(/^https?:\/\/[^/]+/, '');
  rel = rel.replace(/^\/schemas\/latest\//, '/');
  rel = rel.replace(/^\/schemas\/v?\d+(?:\.\d+)*(?:-[^/]+)?\//, '/');
  rel = rel.replace(/^\/schemas\//, '/');
  rel = rel.replace(/^\/+/, '');
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.json$/.test(rel)) return null;
  return rel;
}

/** Examples declared on source schemas, validated against their own schema. */
function schemaExamples(repoRoot) {
  const sourceDir = path.join(repoRoot, 'static', 'schemas', 'source');
  const out = [];
  for (const file of walk(sourceDir, (name) => name.endsWith('.json'))) {
    const rel = path.relative(sourceDir, file).split(path.sep).join('/');
    if (rel.startsWith('extensions/')) continue;
    const schema = readJson(file);
    if (!Array.isArray(schema.examples)) continue;
    schema.examples.forEach((example, index) => {
      const data = example && typeof example === 'object' && 'data' in example ? example.data : example;
      out.push({ id: `schema-example:${rel}#${index}`, schema: rel, data });
    });
  }
  return out;
}

/** `$schema`-tagged JSON fences in the docs, as the docs test reads them. */
function docExamples(repoRoot) {
  const docsDir = path.join(repoRoot, 'docs');
  const out = [];
  const fence = /```json[^\n]*\n([\s\S]*?)```/g;
  for (const file of walk(docsDir, (name) => name.endsWith('.md') || name.endsWith('.mdx'))) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = fence.exec(content)) !== null) {
      const text = match[1].trim();
      if (/\[\.\.\.\]|\{\.\.\.\}|\.\.\./.test(text)) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const schema = schemaPathOf(parsed.$schema);
      if (!schema) continue;
      const data = { ...parsed };
      delete data.$schema;
      const line = content.slice(0, match.index).split('\n').length;
      out.push({ id: `doc:${rel}:${line}`, schema, data });
    }
  }
  return out;
}

/** Storyboard steps that pair a `response_schema_ref` with a `sample_response`. */
function storyboardSamples(repoRoot) {
  const storyboardDir = path.join(repoRoot, 'static', 'compliance', 'source');
  const out = [];
  for (const file of walk(storyboardDir, (name) => name.endsWith('.yaml') || name.endsWith('.yml'))) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    let doc;
    try { doc = yaml.load(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const phase of Array.isArray(doc?.phases) ? doc.phases : []) {
      for (const step of Array.isArray(phase?.steps) ? phase.steps : []) {
        const schema = schemaPathOf(step?.response_schema_ref);
        if (!schema || !step.sample_response || typeof step.sample_response !== 'object') continue;
        out.push({ id: `storyboard:${rel}#${phase.id}/${step.id}`, schema, data: step.sample_response });
      }
    }
  }
  return out;
}

/**
 * Compliance vectors and fixtures that hold task responses. The schema each
 * one is checked against is the one its consuming test uses. A vector file
 * that carries a `status` but no task response (a resolver result, a
 * receipt or tracker outcome) is not listed.
 */
const VECTOR_SOURCES = [
  {
    file: 'static/compliance/source/test-vectors/audience-evidence/vectors.json',
    consumer: 'tests/audience-evidence.test.cjs',
    instances: (v) => [['capability_response', 'protocol/get-adcp-capabilities-response.json', v.capability_response]],
  },
  {
    file: 'static/compliance/source/test-vectors/governance-runtime-attestations/vectors.json',
    consumer: 'tests/governance-runtime-attestations.test.cjs',
    instances: (v) => [['capability_response', 'protocol/get-adcp-capabilities-response.json', v.capability_response]],
  },
  {
    file: 'static/compliance/source/test-vectors/collection-copies/vectors.json',
    consumer: 'tests/collection-copies-vectors.test.cjs',
    instances: (v) => (v.response_vectors || []).filter((vector) => vector.response)
      .map((vector) => [`response_vectors/${vector.id}`, 'media-buy/list-collections-response.json', vector.response]),
  },
  {
    file: 'static/compliance/source/test-vectors/hold-policy/vectors.json',
    consumer: 'tests/hold-policy-vectors.test.cjs',
    instances: (v) => [
      ...['finalize_vectors', 'extend_vectors'].flatMap((group) => (v[group] || []).filter((vector) => vector.response)
        .map((vector) => [`${group}/${vector.id}`, 'media-buy/refine-proposals-response.json', vector.response])),
      ...(v.replay_vectors || []).flatMap((vector) => ['original', 'replay'].filter((side) => vector[side]?.response)
        .map((side) => [`replay_vectors/${vector.id}/${side}`, 'media-buy/refine-proposals-response.json', vector[side].response])),
    ],
  },
  {
    file: 'static/compliance/source/test-vectors/products-only-brief-compatibility/vectors.json',
    consumer: 'tests/products-only-brief-compatibility.test.cjs',
    instances: (v) => [
      ...(v.cases || []).flatMap((c, i) => [
        ...(c.legacy_response ? [[`cases/${i}/legacy_response`, 'media-buy/get-products-response.json', c.legacy_response]] : []),
        ...(c.compact_projection ? [[`cases/${i}/compact_projection`, 'media-buy/request-proposals-response.json', c.compact_projection]] : []),
      ]),
      ...(v.listed_purchase_cases || []).map((c, i) => [`listed_purchase_cases/${i}/compact_projection`, 'media-buy/request-proposals-response.json', c.compact_projection]),
    ],
  },
  ...['accepted-recorded-response', 'accepted-unchanged-response', 'adjustment-accepted-recorded-response', 'rejected-recorded-response'].map((name) => ({
    file: `static/compliance/source/test-vectors/reporting-reconciliation/receipts/${name}.json`,
    consumer: 'tests/reporting-reconciliation-fixture.test.cjs',
    instances: (v) => [['', 'media-buy/sync-reporting-receipts-response.json', v]],
  })),
  {
    file: 'static/compliance/source/test-vectors/reporting-summary/complete-summary.json',
    consumer: 'tests/helpers/reporting-summary-cases.cjs',
    instances: (v) => [['response', schemaPathOf(v.schema_ref), v.response]],
  },
  {
    file: 'static/compliance/source/test-vectors/trusted-match-context-merge/vectors.json',
    consumer: 'tests/trusted-match-context-merge.test.cjs',
    instances: (v) => (v.provider_responses || []).map((r, i) => [`provider_responses/${i}`, 'trusted-match/provider-context-match-response.json', r.response]),
  },
  {
    file: 'static/compliance/source/test-vectors/webhook-receiver-envelope.json',
    consumer: 'tests/webhook-receiver-envelope.test.cjs',
    instances: (v) => ['positive', 'negative'].flatMap((group) => (v[group] || [])
      .map((vector, i) => [`${group}/${vector.id || i}`, 'core/mcp-webhook-payload.json', vector.payload])),
  },
];

function vectorInstances(repoRoot) {
  const out = [];
  for (const source of VECTOR_SOURCES) {
    const vectors = readJson(path.join(repoRoot, source.file));
    for (const [locator, schema, data] of source.instances(vectors)) {
      if (!schema) throw new Error(`${source.file}#${locator}: no schema`);
      if (data === undefined) throw new Error(`${source.file}#${locator}: no instance`);
      out.push({ id: `vector:${source.file}#${locator}`, schema, data });
    }
  }
  return out;
}

function collectResponseInstances(repoRoot) {
  const all = [
    ...schemaExamples(repoRoot),
    ...docExamples(repoRoot),
    ...storyboardSamples(repoRoot),
    ...vectorInstances(repoRoot),
  ];
  const ids = new Set();
  for (const instance of all) {
    // Two identical fences on one line cannot happen; a repeated id is a bug.
    if (ids.has(instance.id)) throw new Error(`duplicate instance id ${instance.id}`);
    ids.add(instance.id);
  }
  return all;
}

module.exports = {
  VECTOR_SOURCES,
  collectResponseInstances,
  schemaPathOf,
};
