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
  assert.equal(validate({ ...HOLDABLE, rankable: true }), false, 'additionalProperties is closed');
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

test('comply_test_controller reports a registered hold failure with the forced proposal_id only', async () => {
  const validate = await compile('/schemas/compliance/comply-test-controller-response.json');
  const forced = { adcp_version: '3.3', status: 'completed', success: true, forced: { proposal_id: 'availnet_draft_01' } };
  assert.equal(validate(forced), true, errors(validate));
  assert.equal(validate({ ...forced, message: 'registered' }), true, errors(validate));
  assert.equal(validate({ ...forced, forced: {} }), false, 'proposal_id is required');
  assert.equal(validate({ ...forced, forced: { proposal_id: 'availnet_draft_01', arm: 'submitted' } }), false, 'no arm on a hold failure');
  assert.equal(validate({ ...forced, forced: { arm: 'submitted' } }), true, 'the arm directive shape is unchanged');
  assert.equal(validate({ ...forced, previous_state: 'draft' }), false, 'not a state transition');

  const arm = readSchema('compliance/comply-test-controller-response.json').oneOf.find(
    branch => branch.title === 'ForcedHoldUnavailableSuccess',
  );
  assert.equal(arm['x-status'], 'experimental');
  assert.equal(arm['x-added-in'], '3.3.0');
  assert.equal(arm.properties.forced.properties.proposal_id['x-added-in'], '3.3.0');
});
