'use strict';

/**
 * Replays static/compliance/source/test-vectors/hold-policy/vectors.json
 * through a reference grader for experimental hold_policy (#7661) and
 * extend_hold (media_buy.hold_extension, #8086), hold ranking
 * (media_buy.hold_ranking, #8086), and installment holds
 * (media_buy.installment_holds, #8086).
 *
 * The grader below is the reference: implementers port it, not the prose.
 * It is deliberately small and reads only canonical proposals, canonical
 * products, and the grader-side request/response times.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { jcs, termsDigest } = require('./helpers/reference-definition-pin.cjs');
const { readComposedSourceSchema } = require('../scripts/compose-response-envelope.cjs');

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
        const schema = readComposedSourceSchema(full, SCHEMAS);
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
  deadlines: ajv.getSchema('/schemas/core/installment-deadlines.json'),
};

// ---------------------------------------------------------------------------
// Reference grader
// ---------------------------------------------------------------------------

const FEATURE = 'media_buy.hold_policy';
const RANKING = 'media_buy.hold_ranking';
const INSTALLMENTS = 'media_buy.installment_holds';
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

const listsFeature = seller => (seller.experimental_features || []).includes(FEATURE);

const sameJson = (a, b) => (a === undefined || b === undefined ? a === b : jcs(a) === jcs(b));

const ranked = h => h && ((h.hold_policy && 'rankable' in h.hold_policy) || 'hold_rank' in h);

function undeclaredExperimental(seller, holders) {
  if (holders.some(h => h && (h.hold_policy || h.hold_placed_at)) && !listsFeature(seller)) return true;
  const features = seller.experimental_features || [];
  if (holders.some(ranked) && !features.includes(RANKING)) return true;
  return holders.some(h => h && 'holds' in h) && !features.includes(INSTALLMENTS);
}

const holdKey = entry => jcs({ product_id: entry.product_id, installment_ref: entry.installment_ref });

/**
 * holds is readback of one hold: each (product_id, installment_ref) once, only
 * allocated products, and a proposal hold_rank no better than any entry's.
 */
function checkHolds(committed, violations) {
  if (!committed.holds) return;
  const keys = committed.holds.map(holdKey);
  if (new Set(keys).size !== keys.length) violations.add('holds_duplicate_entry');
  const allocated = new Set(committed.commercial_terms.purchases.map(p => p.product_id));
  if (committed.holds.some(e => !allocated.has(e.product_id))) violations.add('holds_product_not_allocated');
  if (committed.hold_rank && committed.holds.some(e => e.hold_rank > committed.hold_rank)) {
    violations.add('hold_rank_better_than_entry');
  }
}

/** min <= max <= total after normalizing; the schema cannot compare durations. */
function durationsUnordered(policy) {
  const order = ['min_duration', 'max_duration', 'max_total_duration'].filter(k => policy[k]).map(k => durationMs(policy[k]));
  return order.some((value, i) => i > 0 && order[i - 1] > value);
}

/** A holdable draft promises no more than any allocated product's effective policy. */
function exceedsProducts(draftPolicy, productPolicies) {
  return productPolicies.some(p => {
    if (p.max_duration) {
      const max = durationMs(p.max_duration);
      if (['min_duration', 'max_duration'].some(k => draftPolicy[k] && durationMs(draftPolicy[k]) > max)) return true;
    }
    if (p.max_total_duration && draftPolicy.max_total_duration) {
      if (durationMs(draftPolicy.max_total_duration) > durationMs(p.max_total_duration)) return true;
    }
    if (draftPolicy.extendable === true && p.extendable !== true) return true;
    // A draft is rankable if any allocated product is: an exclusive draft over a rankable product overpromises.
    return p.rankable === true && draftPolicy.rankable !== true;
  });
}

/**
 * Check a placed hold against its policy. Placement is exact when the
 * committed proposal carries hold_placed_at (which must lie in the observed
 * request/response window). Without it (callers below 3.3), placement is
 * anywhere in that window and only bounds that fail for every placement are
 * violations.
 */
function checkBounds(policy, committed, observation, violations, indeterminate) {
  const expires = instant(committed.expires_at);
  const [received, responded] = [instant(observation.request_received_at), instant(observation.response_at)];
  let [earliest, latest] = [received, responded];
  if (committed.hold_placed_at) {
    const placed = instant(committed.hold_placed_at);
    if (placed < received || placed > responded) violations.add('hold_placed_at_outside_window');
    [earliest, latest] = [placed, placed];
  }
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

/**
 * Earliest booking_deadline or change_cutoff across the installments of the
 * products the draft allocates, or undefined when none is declared. A hold
 * never outlives it.
 */
function earliestInstallmentDeadline(draft, installments) {
  const allocated = new Set(draft.commercial_terms.purchases.map(p => p.product_id));
  const instants = (installments || [])
    .filter(i => allocated.has(i.product_id))
    .flatMap(i => [i.deadlines.booking_deadline, i.deadlines.change_cutoff])
    .filter(Boolean)
    .map(instant);
  return instants.length ? Math.min(...instants) : undefined;
}

function gradeFinalize(vector) {
  const violations = new Set();
  const indeterminate = new Set();
  const { seller, source_drafts: drafts, request, observation, response, task_error: taskError } = vector;

  const schemaOk =
    validate.request(request) &&
    drafts.every(d => validate.proposal(d)) &&
    (vector.installments || []).every(i => validate.deadlines(i.deadlines)) &&
    (taskError ? validate.error(taskError) && !response : validate.response(response));
  if (!schemaOk) return { violations: ['schema_invalid'], indeterminate: [] };

  const byId = new Map(drafts.map(d => [d.proposal_id, d]));
  const entries = request.refinements.map(r => byId.get(r.proposal_id));
  const pre33 = belowVersion(request.adcp_version, '3.3');

  const served = [];
  if (response) {
    served.push(...(response.products || []));
    for (const r of response.results) if (r.proposal) served.push(r.proposal);
  }
  if (undeclaredExperimental(seller, [...drafts, ...served])) violations.add('experimental_feature_undeclared');
  if ([...drafts, ...served].some(h => h.hold_policy && durationsUnordered(h.hold_policy))) {
    violations.add('hold_policy_durations_unordered');
  }
  if (pre33) {
    if (served.some(h => h.hold_policy || h.hold_placed_at || 'hold_rank' in h || 'holds' in h)) violations.add('hold_policy_sent_below_3_3');
  } else if (listsFeature(seller)) {
    const proposals = [...drafts, ...served.filter(h => h.proposal_status)];
    if (proposals.some(h => !h.hold_policy)) violations.add('hold_policy_missing');
  }

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
        if (!pre33 && !sameJson(committed.hold_policy, draft.hold_policy)) violations.add('hold_policy_not_carried_forward');
        if (!policy.available && pre33) violations.add('terms_only_committed_below_3_3');
        if (policy.available && draft.hold_policy) {
          checkBounds(draft.hold_policy, committed, observation, violations, indeterminate);
        }
        if (policy.available) {
          const cap = earliestInstallmentDeadline(draft, vector.installments);
          if (cap !== undefined && instant(committed.expires_at) > cap) violations.add('hold_past_installment_deadline');
        }
        checkHolds(committed, violations);
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
  if (listsFeature(seller) && !draft.hold_policy) violations.add('hold_policy_missing');
  if ([draft, ...products].some(h => h.hold_policy && durationsUnordered(h.hold_policy))) {
    violations.add('hold_policy_durations_unordered');
  }
  if (draft.hold_policy && draft.hold_policy.available) {
    const policies = allocated.map(p => effectivePolicy(p, seller));
    if (policies.some(p => !p.available)) violations.add('draft_available_inconsistent');
    else if (exceedsProducts(draft.hold_policy, policies)) violations.add('draft_exceeds_product_policy');
  }
  return { violations: [...violations].sort() };
}

/**
 * Grade an exact retry against the original response. The original is graded
 * as a finalize; the retry must return the same results, and a finalized entry
 * keeps its original hold_placed_at and expires_at (a retry never restarts the
 * clock). The retry is not checked against a new observation window.
 */
function gradeReplay(vector) {
  const original = gradeFinalize({
    seller: vector.seller,
    source_drafts: vector.source_drafts,
    request: vector.request,
    observation: vector.original.observation,
    response: vector.original.response,
  });
  const violations = new Set(original.violations);
  if (violations.has('schema_invalid') || !validate.response(vector.replay.response)) {
    return { violations: ['schema_invalid'] };
  }
  const [first, retry] = [vector.original.response.results, vector.replay.response.results];
  first.forEach((result, i) => {
    const again = retry[i];
    const [a, b] = [result.proposal, again && again.proposal];
    if (a && b && (a.hold_placed_at !== b.hold_placed_at || a.expires_at !== b.expires_at)) {
      violations.add('replay_hold_restarted');
    } else if (!sameJson(result, again)) {
      violations.add('replay_response_changed');
    }
  });
  if (retry.length !== first.length) violations.add('replay_response_changed');
  if (!sameJson(vector.original.response.products, vector.replay.response.products)) violations.add('replay_response_changed');
  return { violations: [...violations].sort() };
}

/**
 * Grade one extend_hold request (experimental, media_buy.hold_extension).
 * Successors carry hold_policy and hold_placed_at forward unchanged, so the
 * max_total_duration ceiling is measured from the root finalize placement.
 */
function gradeExtend(vector) {
  const violations = new Set();
  const { seller, source_proposals: sources, request, response, task_error: taskError } = vector;

  const schemaOk =
    validate.request(request) &&
    sources.every(s => validate.proposal(s)) &&
    (taskError ? validate.error(taskError) && !response : validate.response(response));
  if (!schemaOk) return { violations: ['schema_invalid'] };

  const byId = new Map(sources.map(s => [s.proposal_id, s]));
  const entries = request.refinements.map(r => byId.get(r.proposal_id));
  if (taskError) {
    // Extending a commitment that holds no inventory MUST fail with INVALID_STATE.
    const noHold = entries.some(src => !effectivePolicy(src, seller).available);
    return { violations: noHold && taskError.code !== 'INVALID_STATE' ? ['no_hold_wrong_task_error'] : [] };
  }
  response.results.forEach((result, i) => {
    const src = entries[i];
    const policy = effectivePolicy(src, seller);
    if (result.outcome === 'finalized') {
      const successor = result.proposal;
      if (termsDigest(successor.commercial_terms) !== successor.terms_digest) violations.add('terms_digest_mismatch');
      if (!sameJson(successor.commercial_terms, src.commercial_terms)) violations.add('commercial_terms_changed');
      if (!sameJson(successor.hold_policy, src.hold_policy)) violations.add('hold_policy_not_carried_forward');
      if (successor.hold_placed_at !== src.hold_placed_at) violations.add('hold_placed_at_not_carried_forward');
      // A live hold never moves to a worse position; the successor's snapshot is as of the extension.
      if (src.hold_rank && successor.hold_rank > src.hold_rank) violations.add('hold_rank_worsened');
      checkHolds(successor, violations);
      if (!src.holds !== !successor.holds) violations.add('holds_changed_on_extension');
      if (src.holds) {
        // Extension transfers the same hold: the same entries, each at a position no worse than before.
        const before = new Map(src.holds.map(e => [holdKey(e), e]));
        const after = (successor.holds || []).map(e => [holdKey(e), e]);
        if (after.length !== before.size || after.some(([k]) => !before.has(k))) {
          violations.add('holds_changed_on_extension');
        }
        if (after.some(([k, e]) => before.has(k) && before.get(k).hold_rank && e.hold_rank > before.get(k).hold_rank)) {
          violations.add('hold_rank_worsened');
        }
      }
      if (instant(successor.expires_at) <= instant(src.expires_at)) violations.add('extension_not_later');
      if (src.hold_policy && src.hold_policy.extendable !== true) violations.add('extended_while_not_extendable');
      if (src.hold_policy && src.hold_policy.max_total_duration && src.hold_placed_at) {
        const ceiling = instant(src.hold_placed_at) + durationMs(src.hold_policy.max_total_duration);
        if (instant(successor.expires_at) > ceiling) violations.add('max_total_duration_exceeded');
      }
    } else if (result.outcome === 'unable') {
      if (result.reason_code === 'hold_unavailable' && !policy.available) violations.add('hold_unavailable_without_hold');
      if (result.reason_code === 'batch_aborted') {
        const cause = response.results.some(
          (other, j) => j !== i && other.outcome === 'unable' && other.reason_code !== 'batch_aborted',
        );
        if (!cause) violations.add('batch_aborted_without_cause');
      }
    }
  });
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
