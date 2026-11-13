/**
 * Contract test for experimental installment refinement (adcp#8967,
 * media_buy.installment_refinement).
 *
 * A buyer names installments during refine_proposals; the seller answers with a
 * product whose installments are the chosen set. Nothing enters
 * commercial_terms, so the signed-terms shape stays closed
 * (tests/withdrawn-to-4-0.test.cjs pins the withdrawn signed field).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const readSchema = (relative) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, relative), 'utf8'));

const compiled = new Map();
function compile(schemaId) {
  if (!compiled.has(schemaId)) {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async (uri) => readBuiltSchema(uri) });
    addFormats(ajv);
    compiled.set(schemaId, ajv.compileAsync(readBuiltSchema(schemaId)));
  }
  return compiled.get(schemaId);
}
const errors = (validate) => JSON.stringify(validate.errors, null, 2);

const COLLECTION_REF = { publisher_domain: 'creatorloop.example', collection_id: 'creatorloop_channel_juniper_vale' };
const ref = (id) => ({ collection_ref: { ...COLLECTION_REF }, installment_id: id });
const PRODUCT_ID = 'creatorloop_creator_juniper_vale';

const OMIT = { product_id: PRODUCT_ID, installment_ref: ref('slot_1'), action: 'omit' };
const INCLUDE = { product_id: PRODUCT_ID, installment_ref: ref('slot_3'), action: 'include' };

const revise = (extra) => ({ proposal_id: 'prop_1', action: 'revise', ...extra });

const DRAFT = {
  proposal_id: 'creatorloop_draft_02',
  parent_proposal_id: 'prop_1',
  proposal_kind: 'new_media_buy',
  proposal_status: 'draft',
  expires_at: '2027-01-16T17:00:00Z',
  name: 'Juniper Vale integrations',
  commercial_terms: {
    brand: { domain: 'nova-athletics.example' },
    purchases: [
      {
        product_id: 'creatorloop_creator_juniper_vale_slots_2_3',
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

const unsatisfied = { ...INCLUDE, reason: 'Installment is held for another buyer.' };
const partial = (extra = {}) => ({
  source_proposal_id: 'prop_1',
  outcome: 'partial',
  proposals: [DRAFT],
  reason_code: 'constraint_unsatisfiable',
  reason: 'One requested installment is unavailable.',
  unsatisfied_installment_changes: [unsatisfied],
  ...extra,
});
const response = (result) => ({ status: 'completed', results: [result], products: [] });

test('refinement request: installment_changes alone is a valid revise, including a swap', async () => {
  const validate = await compile('/schemas/media-buy/proposal-refinement.json');
  assert.equal(validate(revise({ installment_changes: [OMIT] })), true, errors(validate));
  assert.equal(validate(revise({ installment_changes: [OMIT, INCLUDE] })), true, errors(validate));
});

test('refinement request: malformed installment_changes are rejected', async () => {
  const validate = await compile('/schemas/media-buy/proposal-refinement.json');
  const { action: _action, ...noAction } = OMIT;
  assert.equal(validate(revise({ installment_changes: [noAction] })), false, 'action is required');
  assert.equal(validate(revise({ installment_changes: [{ ...OMIT, action: 'swap' }] })), false, 'swap is not a verb');
  assert.equal(
    validate(revise({ installment_changes: [{ ...OMIT, installment_ref: { ...ref('slot_1'), extra: 1 } }] })),
    false,
    'installment_ref is closed'
  );
  assert.equal(validate(revise({ installment_changes: [] })), false, 'empty list');
  assert.equal(validate(revise({ installment_changes: [OMIT, { ...OMIT }] })), false, 'exact duplicate entry');
});

test('refinement request: finalize and extend_hold forbid installment_changes', async () => {
  const validate = await compile('/schemas/media-buy/proposal-refinement.json');
  assert.equal(validate({ proposal_id: 'prop_1', action: 'finalize' }), true, errors(validate));
  assert.equal(validate({ proposal_id: 'prop_1', action: 'finalize', installment_changes: [OMIT] }), false);
  assert.equal(validate({ proposal_id: 'prop_1', action: 'extend_hold' }), true, errors(validate));
  assert.equal(validate({ proposal_id: 'prop_1', action: 'extend_hold', installment_changes: [OMIT] }), false);
});

test('change set declares uniqueness by (product_id, installment_ref)', () => {
  const set = readSchema('core/installment-change-set.json');
  assert.deepEqual(set['x-adcp-validation'].unique_by, ['product_id', 'installment_ref']);
  assert.equal(set.uniqueItems, true);
  assert.equal(set.minItems, 1);
  assert.equal(set.maxItems, 500);
});

test('result row: partial with only unsatisfied_installment_changes satisfies constraint_unsatisfiable', async () => {
  const validate = await compile('/schemas/media-buy/refine-proposals-response.json');
  assert.equal(validate(response(partial())), true, errors(validate));
  assert.equal(
    validate(response(partial({ unsatisfied_installment_changes: undefined }))),
    false,
    'constraint_unsatisfiable needs at least one unsatisfied list'
  );
});

test('result row: entries need a reason and the list is forbidden on revised and finalized', async () => {
  const validate = await compile('/schemas/media-buy/refine-proposals-response.json');
  assert.equal(validate(response(partial({ unsatisfied_installment_changes: [INCLUDE] }))), false, 'reason is required');

  const revised = { source_proposal_id: 'prop_1', outcome: 'revised', proposals: [DRAFT] };
  assert.equal(validate(response(revised)), true, errors(validate));
  assert.equal(validate(response({ ...revised, unsatisfied_installment_changes: [unsatisfied] })), false);

  const committed = { ...DRAFT, proposal_status: 'committed' };
  const finalized = { source_proposal_id: 'prop_1', outcome: 'finalized', proposal: committed };
  assert.equal(validate(response(finalized)), true, errors(validate));
  assert.equal(validate(response({ ...finalized, unsatisfied_installment_changes: [unsatisfied] })), false);
});

test('capabilities: installment_changes dimension requires media_buy.installment_refinement', async () => {
  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  const caps = (experimental) => ({
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    media_buy: { lifecycle_tools: ['request_proposals', 'refine_proposals'], proposal_refinement: { supported_dimensions: ['product_changes', 'installment_changes'] } },
    ...(experimental ? { experimental_features: experimental } : {}),
  });
  assert.equal(validate(caps(['media_buy.installment_refinement'])), true, errors(validate));
  assert.equal(validate(caps(undefined)), false, 'no experimental_features');
  assert.equal(validate(caps(['media_buy.hold_policy'])), false, 'wrong experimental feature');
});

test('metadata: the new surfaces are experimental and added in 3.3.0', () => {
  const surfaces = {
    'core/installment-change.json': readSchema('core/installment-change.json'),
    'core/installment-change-set.json': readSchema('core/installment-change-set.json'),
    'proposal-refinement.properties.installment_changes':
      readSchema('media-buy/proposal-refinement.json').properties.installment_changes,
    'result row unsatisfied_installment_changes':
      readSchema('media-buy/refine-proposals-response.json').properties.results.items.properties.unsatisfied_installment_changes,
  };
  for (const [name, schema] of Object.entries(surfaces)) {
    assert.equal(schema['x-status'], 'experimental', `${name} x-status`);
    assert.equal(schema['x-added-in'], '3.3.0', `${name} x-added-in`);
  }
});

test('signed terms are untouched: purchases carry no installments, and only the refinement id has a status row', () => {
  assert.equal(readSchema('media-buy/product-purchase.json').properties.installments, undefined);
  const doc = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
  assert.match(doc, /^\| `media_buy\.installment_refinement` \|/m);
  assert.doesNotMatch(doc, /^\| `media_buy\.installment_selection` \|/m);
});
