'use strict';

/**
 * Replays static/compliance/source/test-vectors/hold-policy/vectors.json
 * through a reference grader for experimental hold_policy (#7661) and
 * extend_hold (media_buy.hold_extension, #8086), hold ranking
 * (media_buy.hold_ranking, #8086), and installment holds
 * (media_buy.installment_holds, #8086).
 *
 * The reference grader lives in tests/helpers/hold-policy-grader.cjs:
 * implementers port it, not the prose.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { termsDigest } = require('./helpers/terms-digest.cjs');
const {
  validate,
  durationMs,
  instant,
  belowVersion,
  gradeFinalize,
  gradeReplay,
  gradeDraft,
  gradeExtend,
} = require('./helpers/hold-policy-grader.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/compliance/source/test-vectors/hold-policy/vectors.json'), 'utf8'),
);

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

for (const vector of vectors.replay_vectors) {
  test(`replay vector ${vector.id}`, () => {
    assert.deepEqual(gradeReplay(vector).violations, [...vector.expected.violations].sort(), vector.name);
  });
}

for (const vector of vectors.draft_vectors) {
  test(`draft vector ${vector.id}`, () => {
    assert.deepEqual(gradeDraft(vector).violations, [...vector.expected.violations].sort(), vector.name);
  });
}

for (const vector of vectors.extend_vectors) {
  test(`extend vector ${vector.id}`, () => {
    assert.deepEqual(gradeExtend(vector).violations, [...vector.expected.violations].sort(), vector.name);
  });
}

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

const allVectors = [
  ...vectors.finalize_vectors,
  ...vectors.replay_vectors,
  ...vectors.draft_vectors,
  ...vectors.extend_vectors,
];

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
    [
      'agent_default',
      'draft_consistency',
      'extension',
      'hold_bounds',
      'hold_unavailable',
      'installment_deadline',
      'installment_holds',
      'ranking',
      'replay',
      'terms_only_resolution',
      'version_gate',
    ],
  );
  for (const [name, counts] of cases) {
    assert.ok(counts.ok > 0 && counts.bad > 0, `${name} needs both verdicts: ${JSON.stringify(counts)}`);
  }
});

test('source drafts are well-formed canonical drafts with recomputable digests', () => {
  for (const v of [...vectors.finalize_vectors, ...vectors.replay_vectors]) {
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
  for (const v of vectors.extend_vectors) {
    for (const s of v.source_proposals) {
      assert.ok(validate.proposal(s), `${v.id}: ${JSON.stringify(validate.proposal.errors)}`);
      assert.equal(s.proposal_status, 'committed');
      assert.equal(termsDigest(s.commercial_terms), s.terms_digest, `${v.id}: ${s.proposal_id}`);
    }
    assert.ok(v.request.refinements.every(r => r.action === 'extend_hold'), `${v.id}: extend_hold only`);
    assert.deepEqual(
      v.request.refinements.map(r => r.proposal_id),
      v.source_proposals.map(s => s.proposal_id),
      `${v.id}: request order matches source_proposals`,
    );
  }
  for (const v of vectors.draft_vectors) {
    assert.equal(termsDigest(v.draft.commercial_terms), v.draft.terms_digest, v.id);
    const ids = new Set(v.products.map(p => p.product_id));
    for (const p of v.draft.commercial_terms.purchases) assert.ok(ids.has(p.product_id), `${v.id}: ${p.product_id}`);
  }
});

test('observations are ordered and carry only the request window', () => {
  const observed = [
    ...vectors.finalize_vectors.map(v => [v.id, v.observation]),
    ...vectors.replay_vectors.map(v => [v.id, v.original.observation]),
  ];
  for (const [id, observation] of observed) {
    assert.deepEqual(Object.keys(observation).sort(), ['request_received_at', 'response_at'], id);
    assert.ok(instant(observation.request_received_at) <= instant(observation.response_at), id);
  }
});

test('installment vectors carry schema-valid deadlines, and only the ignored-product vector names an unallocated product', () => {
  const installmentVectors = vectors.finalize_vectors.filter(f => f.case === 'installment_deadline');
  assert.ok(installmentVectors.length > 0);
  for (const v of installmentVectors) {
    assert.ok(v.installments && v.installments.length > 0, `${v.id}: installments`);
    const allocated = new Set(v.source_drafts.flatMap(d => d.commercial_terms.purchases.map(p => p.product_id)));
    for (const record of v.installments) {
      assert.deepEqual(Object.keys(record).sort(), ['deadlines', 'product_id'], v.id);
      assert.ok(validate.deadlines(record.deadlines), `${v.id}: ${JSON.stringify(validate.deadlines.errors)}`);
      if (v.id !== 'installment-deadline-on-unallocated-product-ignored') {
        assert.ok(allocated.has(record.product_id), `${v.id}: ${record.product_id} is not allocated by a draft`);
      }
    }
  }
  for (const v of vectors.finalize_vectors.filter(f => f.installments)) assert.equal(v.case, 'installment_deadline', v.id);
});

test('a replay presents the original request and a retry whose idempotency key is unchanged', () => {
  for (const v of vectors.replay_vectors) {
    assert.ok(v.request.idempotency_key, v.id);
    assert.equal(v.request.refinements.length, v.original.response.results.length, v.id);
    assert.ok(v.request.refinements.every(r => r.action === 'finalize'), `${v.id}: finalize only`);
    const ids = v.request.refinements.map(r => r.proposal_id);
    assert.deepEqual(ids, v.source_drafts.map(d => d.proposal_id), `${v.id}: request order matches source_drafts`);
    assert.deepEqual(v.replay.response.results.map(r => r.source_proposal_id), ids, `${v.id}: replay results follow the request`);
    assert.equal(v.replay.response.replayed, true, `${v.id}: a retry response is flagged replayed`);
  }
});

test('hold_placed_at is on the wire only for 3.3 callers, and only on committed proposals that hold', () => {
  const responses = [
    ...vectors.finalize_vectors.map(v => [v, v.response]),
    ...vectors.replay_vectors.flatMap(v => [[v, v.original.response], [v, v.replay.response]]),
  ];
  for (const [v, response] of responses) {
    if (!response) continue;
    const pre33 = belowVersion(v.request.adcp_version, '3.3');
    for (const r of response.results) {
      const c = r.proposal;
      if (!c || !c.hold_placed_at) continue;
      assert.ok(c.hold_policy && c.hold_policy.available, `${v.id}: hold_placed_at without a hold`);
      if (pre33) assert.deepEqual(v.expected.violations, ['hold_policy_sent_below_3_3'], v.id);
    }
  }
});

test('every hold_policy in the vectors is coherent: ordered durations, max_total_duration only when extendable', () => {
  const deliberate = new Set(['schema_invalid', 'hold_policy_durations_unordered']);
  const policies = collectPolicies(allVectors.filter(v => !v.expected.violations.some(c => deliberate.has(c))));
  assert.ok(policies.length > 0);
  for (const p of policies) {
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

test('hold_rank appears only beside a rankable hold_policy, and rankable only with available true', () => {
  for (const v of allVectors) {
    if (v.expected.violations.includes('schema_invalid')) continue;
    for (const p of collectPolicies(v)) if ('rankable' in p) assert.equal(p.available, true, v.id);
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if ('hold_rank' in node && !('installment_ref' in node)) {
        assert.equal(node.hold_policy.rankable, true, `${v.id}: hold_rank needs rankable`);
        assert.notEqual(node.proposal_status, 'draft', `${v.id}: no hold_rank on drafts`);
      }
      Object.values(node).forEach(walk);
    };
    walk(v);
  }
});

test('holds appear only on committed proposals that hold inventory', () => {
  for (const v of allVectors) {
    if (v.expected.violations.includes('schema_invalid')) continue;
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if ('holds' in node) {
        assert.equal(node.proposal_status, 'committed', v.id);
        assert.equal(node.hold_policy.available, true, v.id);
        assert.ok(node.hold_placed_at, v.id);
      }
      Object.values(node).forEach(walk);
    };
    walk(v);
  }
});
