const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMA_BASE_DIR = path.join(ROOT, 'static/schemas/source');

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), 'utf8'));
}

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
  return readSchema(uri.replace('/schemas/', ''));
}

const compiled = new Map();
function compile(schemaId) {
  if (!compiled.has(schemaId)) {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(ajv);
    compiled.set(schemaId, ajv.compileAsync(readSchema(schemaId.replace('/schemas/', ''))));
  }
  return compiled.get(schemaId);
}

const errors = (validate) => JSON.stringify(validate.errors, null, 2);
const omit = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

const HOLDABLE = {
  available: true,
  min_duration: 'P2D',
  max_duration: 'P5D',
  extendable: true,
  max_total_duration: 'P14D',
};

const LEGACY_PRODUCT = {
  product_id: 'availnet_creator_slot_0412',
  name: 'Pinnacle Creator upcoming video slot',
  description: 'Integrated sponsorship in the next scheduled video from a Pinnacle Creator channel.',
  publisher_properties: [{ publisher_domain: 'availnet.example', selection_type: 'all' }],
  format_ids: [{ agent_url: 'https://creatives.adcontextprotocol.org', id: 'video_30s' }],
  delivery_type: 'guaranteed',
  pricing_options: [
    { pricing_option_id: 'flat_usd', pricing_model: 'flat_rate', currency: 'USD', fixed_price: 12000 },
  ],
  reporting_capabilities: {
    available_reporting_frequencies: ['daily'],
    expected_delay_minutes: 1440,
    timezone: 'UTC',
    supports_webhooks: false,
    available_metrics: ['impressions'],
    date_range_support: 'date_range',
  },
};

const CANONICAL_PRODUCT = { product_id: 'availnet_creator_slot_0412', name: 'Pinnacle Creator upcoming video slot' };

const DRAFT = {
  proposal_id: 'availnet_draft_01',
  proposal_kind: 'new_media_buy',
  proposal_status: 'draft',
  expires_at: '2027-01-16T17:00:00Z',
  name: 'Creator launch sponsorship',
  commercial_terms: {
    brand: { domain: 'nova-athletics.example' },
    purchases: [
      {
        product_id: 'availnet_creator_slot_0412',
        pricing_option_id: 'flat_usd',
        pricing: { pricing_option_id: 'flat_usd', pricing_model: 'flat_rate', currency: 'USD', fixed_price: 12000 },
        budget: 12000,
        start_time: '2027-03-01T00:00:00Z',
        end_time: '2027-03-31T23:59:59Z',
      },
    ],
    start_time: '2027-03-01T00:00:00Z',
    end_time: '2027-03-31T23:59:59Z',
    total_budget: { amount: 12000, currency: 'USD' },
  },
  terms_digest: 'sha256:IO3B2jLn52O7-u_xeztyhTFDUJWbV4mQrCcTfCWpAQg',
};

test('hold_policy validates standalone and rejects undeclared properties', async () => {
  const validate = await compile('/schemas/core/hold-policy.json');
  assert.equal(validate(HOLDABLE), true, errors(validate));
  assert.equal(validate({ available: true }), true, errors(validate));
  assert.equal(validate({ available: false }), true, errors(validate));
  assert.equal(validate({ available: false, extendable: false }), false, 'extendable is forbidden without a hold');
  assert.equal(validate({}), false, 'available is required');
  assert.equal(validate({ ...HOLDABLE, undeclared: true }), false, 'additionalProperties is closed');
  assert.equal(validate({ available: 'yes' }), false);
});

test('durations are strictly positive and limited to days, hours, minutes, and seconds', async () => {
  const validate = await compile('/schemas/core/hold-policy.json');
  for (const value of ['P2D', 'PT36H', 'PT90M', 'PT45S', 'P1DT12H', 'P10D', 'P1DT0H']) {
    assert.equal(validate({ available: true, min_duration: value }), true, `${value} should be valid: ${errors(validate)}`);
  }
  for (const value of ['P0D', 'PT0S', 'P1M', 'P1Y', 'P1W', 'P', 'PT', 'P1DT', 'PT1.5H', '2D', 'p2d', '']) {
    assert.equal(validate({ available: true, max_duration: value }), false, `${value} should be invalid`);
  }
  const schema = readSchema('core/hold-policy.json');
  for (const field of ['min_duration', 'max_duration', 'max_total_duration']) {
    assert.equal(schema.properties[field].$ref, '#/definitions/positive_duration', `${field} reuses the shared pattern`);
  }
});

test('available false forbids every duration', async () => {
  const validate = await compile('/schemas/core/hold-policy.json');
  for (const field of ['min_duration', 'max_duration', 'max_total_duration']) {
    assert.equal(validate({ available: false, [field]: 'P2D' }), false, `${field} is forbidden without a hold`);
  }
});

test('max_total_duration requires extendable true, and extendable defaults to false', async () => {
  const validate = await compile('/schemas/core/hold-policy.json');
  assert.equal(validate({ available: true, max_duration: 'P5D', max_total_duration: 'P14D' }), false, 'no extendable');
  assert.equal(
    validate({ available: true, max_duration: 'P5D', extendable: false, max_total_duration: 'P14D' }),
    false,
    'extendable false',
  );
  assert.equal(validate({ available: true, max_duration: 'P5D', extendable: true, max_total_duration: 'P14D' }), true, errors(validate));
  assert.equal(validate({ available: true, extendable: false }), true, errors(validate));
  assert.equal(readSchema('core/hold-policy.json').properties.extendable.default, false);
});

test('legacy and canonical products carry hold_policy', async () => {
  const validateProduct = await compile('/schemas/core/product.json');
  assert.equal(validateProduct(LEGACY_PRODUCT), true, errors(validateProduct));
  assert.equal(validateProduct({ ...LEGACY_PRODUCT, hold_policy: HOLDABLE }), true, errors(validateProduct));
  assert.equal(validateProduct({ ...LEGACY_PRODUCT, hold_policy: { available: false } }), true, errors(validateProduct));
  assert.equal(validateProduct({ ...LEGACY_PRODUCT, hold_policy: { available: false, min_duration: 'P2D' } }), false);

  const validateCanonical = await compile('/schemas/core/canonical-product.json');
  assert.equal(validateCanonical({ ...CANONICAL_PRODUCT, hold_policy: HOLDABLE }), true, errors(validateCanonical));
  assert.equal(validateCanonical({ ...CANONICAL_PRODUCT, hold_policy: { ...HOLDABLE, undeclared: 1 } }), false);
});

test('only canonical proposals carry hold_policy; the legacy proposal does not', async () => {
  assert.equal(readSchema('core/proposal.json').properties.hold_policy, undefined, 'legacy proposal has no hold_policy');
  assert.equal(readSchema('core/proposal.json').properties.hold_placed_at, undefined, 'legacy proposal has no hold_placed_at');

  const validateCanonical = await compile('/schemas/core/canonical-proposal.json');
  assert.equal(validateCanonical({ ...DRAFT, hold_policy: { available: false } }), true, errors(validateCanonical));
  assert.equal(validateCanonical({ ...DRAFT, hold_policy: HOLDABLE }), true, errors(validateCanonical));
  assert.equal(validateCanonical({ ...DRAFT, hold_policy: { available: false, max_total_duration: 'P14D' } }), false);
});

test('a committed proposal that holds inventory carries hold_placed_at', async () => {
  const validate = await compile('/schemas/core/canonical-proposal.json');
  const committed = {
    ...DRAFT,
    proposal_id: 'availnet_committed_01',
    parent_proposal_id: DRAFT.proposal_id,
    proposal_status: 'committed',
    hold_policy: HOLDABLE,
    hold_placed_at: '2027-01-14T17:00:00Z',
  };
  assert.equal(validate(committed), true, errors(validate));

  const unplaced = omit(committed, 'hold_placed_at');
  assert.equal(validate(unplaced), false, 'required when committed with available true');
  assert.equal(validate({ ...committed, hold_placed_at: 'yesterday' }), false, 'date-time');

  const termsOnly = { ...unplaced, hold_policy: { available: false } };
  assert.equal(validate(termsOnly), true, errors(validate));
  assert.equal(validate({ ...termsOnly, hold_placed_at: committed.hold_placed_at }), false, 'forbidden without a hold');

  assert.equal(validate(omit(committed, 'hold_policy')), false, 'hold_placed_at needs hold_policy');
  assert.equal(
    validate({ ...DRAFT, hold_policy: HOLDABLE, hold_placed_at: committed.hold_placed_at }),
    false,
    'forbidden on a draft',
  );
});

test('a request_proposals response carries a draft hold_policy beside product policies', async () => {
  const validate = await compile('/schemas/media-buy/request-proposals-response.json');
  const response = {
    outcome: 'proposed',
    proposals: [{ ...DRAFT, hold_policy: { available: true, min_duration: 'P2D' } }],
    products: [{ ...CANONICAL_PRODUCT, hold_policy: HOLDABLE }],
  };
  assert.equal(validate(response), true, errors(validate));
  response.proposals[0].hold_policy = { available: true, min_duration: 'P0D' };
  assert.equal(validate(response), false);
});

test('hold_policy surfaces are experimental 3.3 additions', () => {
  const holdPolicy = readSchema('core/hold-policy.json');
  assert.equal(holdPolicy['x-status'], 'experimental');
  assert.equal(holdPolicy['x-added-in'], '3.3.0');
  assert.equal(holdPolicy.additionalProperties, false);
  assert.deepEqual(holdPolicy.required, ['available']);
  for (const [name, field] of Object.entries(holdPolicy.properties)) {
    assert.equal(field['x-status'], 'experimental', `${name} x-status`);
    assert.equal(field['x-added-in'], '3.3.0', `${name} x-added-in`);
  }
  assert.match(holdPolicy.description, /media_buy\.hold_policy/);
  assert.match(holdPolicy.description, /rank/i, 'leaves room for hold ranking');

  for (const file of ['core/product.json', 'core/canonical-product.json', 'core/canonical-proposal.json']) {
    const field = readSchema(file).properties.hold_policy;
    assert.ok(field, `${file} declares hold_policy`);
    assert.equal(field.$ref, '/schemas/core/hold-policy.json', `${file} references the shared schema`);
    assert.equal(field['x-status'], 'experimental', `${file} x-status`);
    assert.equal(field['x-added-in'], '3.3.0', `${file} x-added-in`);
  }

  const placedAt = readSchema('core/canonical-proposal.json').properties.hold_placed_at;
  assert.equal(placedAt.format, 'date-time');
  assert.equal(placedAt['x-status'], 'experimental');
  assert.equal(placedAt['x-added-in'], '3.3.0');
  assert.match(placedAt.description, /media_buy\.hold_policy/);

  const capabilities = readSchema('protocol/get-adcp-capabilities-response.json');
  const holdSemantics = JSON.stringify(capabilities).match(/"hold_semantics":\{[^}]*\}/);
  assert.ok(holdSemantics, 'hold_semantics capability exists');
  assert.match(holdSemantics[0], /products and drafts that do not declare hold_policy/, 'hold_semantics is the per-product default');
  assert.match(holdSemantics[0], /per finalize entry/, 'terms_only rules apply per entry');
});

test('experimental-status registry lists media_buy.hold_policy', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
  const row = registry.split('\n').find((line) => line.startsWith('| `media_buy.hold_policy` |'));
  assert.ok(row, 'registry row present');
  assert.match(row, /core\/hold-policy\.json/);
  assert.match(row, /Availnet/);
});

test('comply_test_controller force_hold_unavailable requires the draft proposal_id', async () => {
  const validate = await compile('/schemas/compliance/comply-test-controller-request.json');
  const request = params => ({
    adcp_version: '3.3',
    scenario: 'force_hold_unavailable',
    account: { sandbox: true },
    ...params,
  });
  assert.equal(validate(request({ params: { proposal_id: 'availnet_draft_01' } })), true, errors(validate));
  assert.equal(validate(request({})), false, 'params is required');
  assert.equal(validate(request({ params: {} })), false, 'proposal_id is required');
  assert.equal(validate(request({ params: { proposal_id: '' } })), false, 'proposal_id is not empty');
});

test('comply_test_controller reports a registered hold failure as the unable arm with the forced proposal_id', async () => {
  const validate = await compile('/schemas/compliance/comply-test-controller-response.json');
  const forced = {
    adcp_version: '3.3',
    status: 'completed',
    success: true,
    forced: { arm: 'unable', proposal_id: 'availnet_draft_01' },
  };
  assert.equal(validate(forced), true, errors(validate));
  assert.equal(validate({ ...forced, message: 'registered' }), true, errors(validate));
  assert.equal(validate({ ...forced, forced: { arm: 'unable' } }), false, 'proposal_id is required for the unable arm');
  assert.equal(validate({ ...forced, forced: { proposal_id: 'availnet_draft_01' } }), false, 'arm is required');
  assert.equal(validate({ ...forced, forced: { arm: 'unable', proposal_id: 'p', task_id: 't' } }), false, 'no task_id on unable');
  assert.equal(validate({ ...forced, forced: { arm: 'submitted', proposal_id: 'p', task_id: 't' } }), false, 'proposal_id is only for the unable arm');
  assert.equal(validate({ ...forced, forced: { arm: 'submitted', task_id: 't' } }), true, 'the existing arm directives are unchanged');
  assert.equal(validate({ ...forced, previous_state: 'draft' }), false, 'not a state transition');

  const directive = readSchema('compliance/comply-test-controller-response.json').oneOf.find(
    branch => branch.title === 'ForcedDirectiveSuccess',
  );
  const proposalId = directive.properties.forced.properties.proposal_id;
  assert.equal(proposalId['x-status'], 'experimental');
  assert.equal(proposalId['x-added-in'], '3.3.0');
  assert.match(directive.properties.forced.properties.arm.description, /force_hold_unavailable/);
});

test('rankable is a hold-only boolean that defaults to false', async () => {
  const validate = await compile('/schemas/core/hold-policy.json');
  assert.equal(validate({ ...HOLDABLE, rankable: true }), true, errors(validate));
  assert.equal(validate({ available: true, rankable: false }), true, errors(validate));
  assert.equal(validate({ available: false, rankable: true }), false, 'rankable is forbidden without a hold');
  assert.equal(validate({ available: false, rankable: false }), false, 'even false is forbidden without a hold');
  assert.equal(validate({ available: true, rankable: 'yes' }), false);
  const rankable = readSchema('core/hold-policy.json').properties.rankable;
  assert.equal(rankable.default, false);
  assert.match(rankable.description, /media_buy\.hold_ranking/);
  assert.match(readSchema('core/hold-policy.json').properties.available.description, /not reinterpreted/);
});

test('a committed proposal holding a ranked hold reports hold_rank, and only then', async () => {
  const validate = await compile('/schemas/core/canonical-proposal.json');
  const ranked = {
    ...DRAFT,
    proposal_id: 'availnet_committed_02',
    parent_proposal_id: DRAFT.proposal_id,
    proposal_status: 'committed',
    hold_policy: { ...HOLDABLE, rankable: true },
    hold_placed_at: '2027-01-14T17:00:00Z',
    hold_rank: 2,
  };
  assert.equal(validate(ranked), true, errors(validate));
  assert.equal(validate({ ...ranked, hold_rank: 1 }), true, errors(validate));
  assert.equal(validate(omit(ranked, 'hold_rank')), false, 'required under a rankable policy');
  assert.equal(validate({ ...ranked, hold_rank: 0 }), false, 'positions start at 1');
  assert.equal(validate({ ...ranked, hold_rank: 1.5 }), false, 'integer');

  const exclusive = { ...ranked, hold_policy: HOLDABLE };
  assert.equal(validate(omit(exclusive, 'hold_rank')), true, errors(validate));
  assert.equal(validate(exclusive), false, 'forbidden when rankable is absent');
  assert.equal(validate({ ...exclusive, hold_policy: { ...HOLDABLE, rankable: false } }), false, 'forbidden when rankable is false');
  assert.equal(validate(omit(ranked, 'hold_policy')), false, 'hold_rank needs hold_policy');
  assert.equal(
    validate({ ...DRAFT, hold_policy: { ...HOLDABLE, rankable: true }, hold_rank: 1 }),
    false,
    'forbidden on a draft',
  );
  assert.equal(validate({ ...DRAFT, hold_policy: { ...HOLDABLE, rankable: true } }), true, 'a rankable draft has no rank');

  const rank = readSchema('core/canonical-proposal.json').properties.hold_rank;
  assert.equal(rank['x-status'], 'experimental');
  assert.equal(rank['x-added-in'], '3.3.0');
  assert.match(rank.description, /media_buy\.hold_ranking/);
  assert.match(rank.description, /MUST NOT move a live hold to a worse position/);
  assert.match(rank.description, /MUST NOT disclose any other buyer/);
});

test('experimental-status registry lists media_buy.hold_ranking', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
  const row = registry.split('\n').find((line) => line.startsWith('| `media_buy.hold_ranking` |'));
  assert.ok(row, 'registry row present');
  assert.match(row, /hold_rank/);
  assert.match(row, /Availnet/);
});

test('holds is readback of one placed hold: committed, holding, and closed per entry', async () => {
  const validate = await compile('/schemas/core/canonical-proposal.json');
  const ref = id => ({ collection_ref: { publisher_domain: 'availnet.example', collection_id: 'pinnacle_creator' }, installment_id: id });
  const committed = {
    ...DRAFT,
    proposal_id: 'availnet_committed_03',
    parent_proposal_id: DRAFT.proposal_id,
    proposal_status: 'committed',
    hold_policy: HOLDABLE,
    hold_placed_at: '2027-01-14T17:00:00Z',
    holds: [
      { product_id: 'availnet_creator_slot_0412', installment_ref: ref('ep_041') },
      { product_id: 'availnet_creator_slot_0412', installment_ref: ref('ep_042') },
    ],
  };
  assert.equal(validate(committed), true, errors(validate));
  assert.equal(validate({ ...committed, holds: [] }), false, 'minItems 1');
  assert.equal(
    validate({ ...committed, holds: [{ ...committed.holds[0], expires_at: '2027-01-15T17:00:00Z' }] }),
    false,
    'entries carry no expires_at of their own',
  );
  assert.equal(validate({ ...committed, holds: [{ product_id: 'availnet_creator_slot_0412' }] }), false, 'installment_ref required');
  assert.equal(
    validate({ ...omit(committed, 'hold_placed_at'), hold_policy: { available: false } }),
    false,
    'forbidden on a terms-only commitment',
  );
  assert.equal(validate({ ...DRAFT, hold_policy: HOLDABLE, holds: committed.holds }), false, 'forbidden on a draft');
  assert.equal(validate(omit(omit(committed, 'hold_policy'), 'hold_placed_at')), false, 'needs hold_policy');

  const ranked = { ...committed, hold_policy: { ...HOLDABLE, rankable: true }, hold_rank: 2 };
  const rankedHolds = [
    { ...committed.holds[0], hold_rank: 1 },
    { ...committed.holds[1], hold_rank: 2 },
  ];
  assert.equal(validate({ ...ranked, holds: rankedHolds }), true, errors(validate));
  assert.equal(validate(ranked), false, 'entries carry hold_rank when the proposal does');
  assert.equal(validate({ ...committed, holds: rankedHolds }), false, 'and not when it does not');

  const holds = readSchema('core/canonical-proposal.json').properties.holds;
  assert.equal(holds['x-status'], 'experimental');
  assert.equal(holds['x-added-in'], '3.3.0');
  assert.match(holds.description, /media_buy\.installment_holds/);
  assert.match(holds.description, /no partial holds/);
  assert.match(holds.description, /MUST NOT include or describe other buyers/);
  assert.equal(holds.items.properties.installment_ref.$ref, '/schemas/core/installment-ref.json');
  assert.equal(holds.items.properties.product_id['x-entity'], 'product');
});

test('experimental-status registry lists media_buy.installment_holds', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
  const row = registry.split('\n').find((line) => line.startsWith('| `media_buy.installment_holds` |'));
  assert.ok(row, 'registry row present');
  assert.match(row, /installment_ref/);
  assert.match(row, /Availnet/);
});
