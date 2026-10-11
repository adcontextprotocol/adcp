'use strict';

/**
 * Replays static/compliance/source/test-vectors/hold-policy/vectors.json
 * through a reference grader for experimental hold_policy (#7661).
 *
 * The grader below is the reference: implementers port it, not the prose.
 * It is deliberately small and reads only canonical proposals, canonical
 * products, and the grader-side observation record.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { jcs, termsDigest } = require('./helpers/reference-definition-pin.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/compliance/source/test-vectors/hold-policy/vectors.json'), 'utf8'),
);

function loadSchemas() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      }
    }
  };
  walk(SCHEMAS);
  return ajv;
}

const ajv = loadSchemas();
const validate = {
  request: ajv.getSchema('/schemas/media-buy/refine-proposals-request.json'),
  response: ajv.getSchema('/schemas/media-buy/refine-proposals-response.json'),
  proposal: ajv.getSchema('/schemas/core/canonical-proposal.json'),
  product: ajv.getSchema('/schemas/core/canonical-product.json'),
  error: ajv.getSchema('/schemas/core/error.json'),
  policy: ajv.getSchema('/schemas/core/hold-policy.json'),
};

// ---------------------------------------------------------------------------
// Reference grader
// ---------------------------------------------------------------------------

const FEATURE = 'media_buy.hold_policy';
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Duration in milliseconds. A day is 86400 seconds on the UTC instant. */
function durationMs(value) {
  const match = DURATION.exec(value);
  if (!match) throw new Error(`unsupported duration ${value}`);
  const [d, h, m, s] = match.slice(1).map(part => Number(part || 0));
  return (((d * 24 + h) * 60 + m) * 60 + s) * 1000;
}

function instant(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`unparseable date-time ${value}`);
  return ms;
}

function belowVersion(version, floor) {
  const parse = v => v.split('-')[0].split('.').map(Number);
  const [a, b] = [parse(version), parse(floor)];
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function effectivePolicy(holder, seller) {
  if (holder.hold_policy) return holder.hold_policy;
  return { available: seller.hold_semantics !== 'terms_only' };
}

const sameJson = (a, b) => (a === undefined || b === undefined ? a === b : jcs(a) === jcs(b));

function undeclaredExperimental(seller, holders) {
  return holders.some(h => h && h.hold_policy) && !(seller.experimental_features || []).includes(FEATURE);
}

/**
 * Check a placed hold against its policy. Placement is exact when the grader
 * recorded hold_placed_at; otherwise it is anywhere in the request/response
 * window and only bounds that fail for every placement are violations.
 */
function checkBounds(policy, expiresAt, observation, violations, indeterminate) {
  const expires = instant(expiresAt);
  const [earliest, latest] = observation.hold_placed_at
    ? [instant(observation.hold_placed_at), instant(observation.hold_placed_at)]
    : [instant(observation.request_received_at), instant(observation.response_at)];
  if (policy.min_duration) {
    const min = durationMs(policy.min_duration);
    if (expires < earliest + min) violations.add('min_duration_not_honored');
    else if (expires < latest + min) indeterminate.add('min_duration');
  }
  if (policy.max_duration) {
    const max = durationMs(policy.max_duration);
    if (expires > latest + max) violations.add('max_duration_exceeded');
    else if (expires > earliest + max) indeterminate.add('max_duration');
  }
}

function gradeFinalize(vector) {
  const violations = new Set();
  const indeterminate = new Set();
  const { seller, source_drafts: drafts, request, observation, response, task_error: taskError } = vector;

  const schemaOk =
    validate.request(request) &&
    drafts.every(d => validate.proposal(d)) &&
    (taskError ? validate.error(taskError) && !response : validate.response(response));
  if (!schemaOk) return { violations: ['schema_invalid'], indeterminate: [] };

  const byId = new Map(drafts.map(d => [d.proposal_id, d]));
  const entries = request.refinements.map(r => byId.get(r.proposal_id));
  const pre33 = belowVersion(request.adcp_version, '3.3');

  const holders = [...drafts];
  if (response) {
    holders.push(...(response.products || []));
    for (const r of response.results) if (r.proposal) holders.push(r.proposal);
  }
  if (undeclaredExperimental(seller, holders)) violations.add('experimental_feature_undeclared');

  if (taskError) {
    const gateApplies = pre33 && entries.some(d => !effectivePolicy(d, seller).available);
    if (taskError.code === 'UNSUPPORTED_FEATURE' && !gateApplies) violations.add('unsupported_feature_without_cause');
  } else {
    response.results.forEach((result, i) => {
      const draft = entries[i];
      const policy = effectivePolicy(draft, seller);
      if (result.outcome === 'finalized') {
        const committed = result.proposal;
        if (termsDigest(committed.commercial_terms) !== committed.terms_digest) violations.add('terms_digest_mismatch');
        if (!sameJson(committed.commercial_terms, draft.commercial_terms)) violations.add('commercial_terms_changed');
        if (!sameJson(committed.hold_policy, draft.hold_policy)) violations.add('hold_policy_not_carried_forward');
        if (!policy.available && pre33) violations.add('terms_only_committed_below_3_3');
        if (policy.available && draft.hold_policy) {
          checkBounds(draft.hold_policy, committed.expires_at, observation, violations, indeterminate);
        }
      } else if (result.outcome === 'unable') {
        if (result.reason_code === 'hold_unavailable' && !policy.available) {
          violations.add('hold_unavailable_without_hold');
        }
        if (result.reason_code === 'batch_aborted') {
          const cause = response.results.some(
            (other, j) => j !== i && other.outcome === 'unable' && other.reason_code !== 'batch_aborted',
          );
          if (!cause) violations.add('batch_aborted_without_cause');
        }
      }
    });
  }
  return { violations: [...violations].sort(), indeterminate: [...indeterminate].sort() };
}

function gradeDraft(vector) {
  const { seller, products, draft } = vector;
  if (!validate.proposal(draft) || !products.every(p => validate.product(p))) {
    return { violations: ['schema_invalid'] };
  }
  const violations = new Set();
  const byId = new Map(products.map(p => [p.product_id, p]));
  const allocated = [...new Set(draft.commercial_terms.purchases.map(p => p.product_id))].map(id => byId.get(id));

  if (undeclaredExperimental(seller, [draft, ...products])) violations.add('experimental_feature_undeclared');
  if (allocated.some(p => p.hold_policy) && !draft.hold_policy) violations.add('draft_hold_policy_missing');
  if (draft.hold_policy && draft.hold_policy.available && allocated.some(p => !effectivePolicy(p, seller).available)) {
    violations.add('draft_available_inconsistent');
  }
  return { violations: [...violations].sort() };
}

// ---------------------------------------------------------------------------
// Vector replay
// ---------------------------------------------------------------------------

for (const vector of vectors.finalize_vectors) {
  test(`finalize vector ${vector.id}`, () => {
    const result = gradeFinalize(vector);
    assert.deepEqual(result.violations, [...vector.expected.violations].sort(), vector.name);
    assert.deepEqual(result.indeterminate, [...(vector.expected.indeterminate || [])].sort(), vector.name);
  });
}

for (const vector of vectors.draft_vectors) {
  test(`draft vector ${vector.id}`, () => {
    assert.deepEqual(gradeDraft(vector).violations, [...vector.expected.violations].sort(), vector.name);
  });
}

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

const allVectors = [...vectors.finalize_vectors, ...vectors.draft_vectors];

function collectPolicies(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => collectPolicies(n, out));
  else if (node && typeof node === 'object') {
    if (node.hold_policy) out.push(node.hold_policy);
    Object.values(node).forEach(n => collectPolicies(n, out));
  }
  return out;
}

test('vector ids are unique and every violation code is defined and exercised', () => {
  const ids = allVectors.map(v => v.id);
  assert.equal(new Set(ids).size, ids.length);
  const defined = Object.keys(vectors.violation_codes);
  const used = new Set(allVectors.flatMap(v => v.expected.violations));
  for (const code of used) assert.ok(defined.includes(code), `undefined violation code ${code}`);
  for (const code of defined) assert.ok(used.has(code), `violation code ${code} has no vector`);
});

test('every case has at least one conformant and one non-conformant vector', () => {
  const cases = new Map();
  for (const v of allVectors) {
    const entry = cases.get(v.case) || { ok: 0, bad: 0 };
    entry[v.expected.violations.length ? 'bad' : 'ok'] += 1;
    cases.set(v.case, entry);
  }
  assert.deepEqual(
    [...cases.keys()].sort(),
    ['agent_default', 'draft_consistency', 'hold_bounds', 'hold_unavailable', 'terms_only_resolution', 'version_gate'],
  );
  for (const [name, counts] of cases) {
    assert.ok(counts.ok > 0 && counts.bad > 0, `${name} needs both verdicts: ${JSON.stringify(counts)}`);
  }
});

test('source drafts are well-formed canonical drafts with recomputable digests', () => {
  for (const v of vectors.finalize_vectors) {
    for (const d of v.source_drafts) {
      assert.ok(validate.proposal(d), `${v.id}: ${JSON.stringify(validate.proposal.errors)}`);
      assert.equal(d.proposal_status, 'draft');
      assert.equal(termsDigest(d.commercial_terms), d.terms_digest, `${v.id}: ${d.proposal_id}`);
    }
    assert.deepEqual(
      v.request.refinements.map(r => r.proposal_id),
      v.source_drafts.map(d => d.proposal_id),
      `${v.id}: request order matches source_drafts`,
    );
  }
  for (const v of vectors.draft_vectors) {
    assert.equal(termsDigest(v.draft.commercial_terms), v.draft.terms_digest, v.id);
    const ids = new Set(v.products.map(p => p.product_id));
    for (const p of v.draft.commercial_terms.purchases) assert.ok(ids.has(p.product_id), `${v.id}: ${p.product_id}`);
  }
});

test('observations are ordered and hold_placed_at lies inside the request window', () => {
  for (const v of vectors.finalize_vectors) {
    const { request_received_at: received, response_at: responded, hold_placed_at: placed } = v.observation;
    assert.ok(instant(received) <= instant(responded), v.id);
    if (placed) assert.ok(instant(received) <= instant(placed) && instant(placed) <= instant(responded), v.id);
  }
});

test('every hold_policy in the vectors is coherent: ordered durations, max_total_duration only when extendable', () => {
  const policies = collectPolicies(allVectors);
  assert.ok(policies.length > 0);
  for (const p of policies) {
    if (p.available === false && Object.keys(p).length > 1) continue; // the deliberate schema_invalid vector
    assert.ok(validate.policy(p), JSON.stringify(validate.policy.errors));
    if ('max_total_duration' in p) assert.equal(p.extendable, true, JSON.stringify(p));
    if (p.min_duration && p.max_duration) assert.ok(durationMs(p.min_duration) <= durationMs(p.max_duration));
    if (p.max_duration && p.max_total_duration) {
      assert.ok(durationMs(p.max_duration) <= durationMs(p.max_total_duration));
    }
  }
});

test('the duration reader agrees with the schema pattern and treats a day as 24 hours', () => {
  const pattern = new RegExp(
    JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'core/hold-policy.json'), 'utf8')).definitions.positive_duration.pattern,
  );
  for (const value of ['P1D', 'PT24H', 'PT36H', 'P1DT12H', 'PT90M', 'PT45S', 'P2DT3H4M5S']) {
    assert.ok(pattern.test(value), value);
    assert.ok(durationMs(value) > 0, value);
  }
  for (const value of ['P1W', 'P1M', 'P1Y', 'P0D', 'PT', 'P']) assert.equal(pattern.test(value), false, value);
  assert.equal(durationMs('P1D'), durationMs('PT24H'));
  assert.equal(durationMs('P1DT12H'), durationMs('PT36H'));
});

test('version comparison is by major and minor', () => {
  assert.equal(belowVersion('3.2', '3.3'), true);
  assert.equal(belowVersion('3.3', '3.3'), false);
  assert.equal(belowVersion('3.3-rc.1', '3.3'), false);
  assert.equal(belowVersion('3.10', '3.3'), false);
  assert.equal(belowVersion('2.5', '3.3'), true);
});
