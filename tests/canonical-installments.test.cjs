/**
 * Contract test for installments on the compact product lifecycle (#8230).
 *
 * The canonical Product can now name the specific episodes, issues, airings or
 * creator slots it sells, and a proposal purchase can name the exact ones it
 * buys. Each assertion below pins one property that a later change could
 * quietly drop:
 *
 * - the canonical installment is identified by the (collection_ref,
 *   installment_id) tuple alone, so the deprecated collection_id shorthand
 *   cannot leak into the closed shape;
 * - legacy get_products keeps that shorthand, because removing it is a major
 *   change and the legacy Product is not what the compact lifecycle reads;
 * - absence of Product.installments means run-of-collection, not "unknown";
 * - installments live inside commercial_terms, so dropping or swapping a slot
 *   moves terms_digest and therefore the accept_proposal binding;
 * - installment_changes is a revise-only dimension, gated on the experimental
 *   feature id, and reports its failures through unsatisfied_installment_changes.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { termsDigest } = require('./helpers/reference-definition-pin.cjs');

const ROOT = path.join(__dirname, '..');
const SCHEMA_BASE_DIR = path.join(ROOT, 'static/schemas/source');
const DOCS = path.join(ROOT, 'docs');

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), 'utf8'));
}

function readDoc(relativePath) {
  return fs.readFileSync(path.join(DOCS, relativePath), 'utf8');
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

const PUBLISHER = 'creatorloop.example';
const COLLECTION_ID = 'creatorloop_channel_juniper_vale';
const COLLECTION_REF = { publisher_domain: PUBLISHER, collection_id: COLLECTION_ID };
const PRODUCT_ID = 'creatorloop_creator_juniper_vale';

const ref = (installmentId) => ({ collection_ref: { ...COLLECTION_REF }, installment_id: installmentId });
const change = (installmentId, action) => ({ product_id: PRODUCT_ID, installment_ref: ref(installmentId), action });

const slot = (n, overrides = {}) => ({
  installment_id: `juniper_vale_slot_${n}`,
  collection_ref: { ...COLLECTION_REF },
  name: `Juniper Vale Cooks: sponsored integration ${n}`,
  status: 'scheduled',
  scheduled_at: `2026-12-${String(10 + n * 2).padStart(2, '0')}T17:00:00Z`,
  duration_seconds: 720,
  deadlines: {
    booking_deadline: `2026-11-${String(10 + n * 2).padStart(2, '0')}T17:00:00Z`,
    material_deadlines: [
      { stage: 'talking_points', due_at: `2026-11-${String(20 + n).padStart(2, '0')}T17:00:00Z` },
    ],
  },
  ...overrides,
});

const CANONICAL_PRODUCT = {
  product_id: PRODUCT_ID,
  name: 'Juniper Vale Cooks sponsored video',
  collections: [{ publisher_domain: PUBLISHER, collection_ids: [COLLECTION_ID] }],
};

const PURCHASE = {
  product_id: PRODUCT_ID,
  pricing_option_id: 'flat_usd',
  pricing: { pricing_option_id: 'flat_usd', pricing_model: 'flat_rate', currency: 'USD', fixed_price: 6500 },
  start_time: '2026-12-01T00:00:00Z',
  end_time: '2027-01-31T23:59:59Z',
};

const termsWith = (installments) => ({
  brand: { domain: 'nova-athletics.example' },
  purchases: [installments ? { ...PURCHASE, installments } : { ...PURCHASE }],
  start_time: '2026-12-01T00:00:00Z',
  end_time: '2027-01-31T23:59:59Z',
  total_budget: { amount: 13000, currency: 'USD' },
});

test('a canonical installment is identified by the (collection_ref, installment_id) tuple alone', async () => {
  const validate = await compile('/schemas/core/canonical-installment.json');
  assert.equal(validate(slot(1)), true, errors(validate));
  assert.equal(validate({ installment_id: 'slot_1', collection_ref: { ...COLLECTION_REF } }), true, errors(validate));

  assert.equal(validate(omit(slot(1), 'collection_ref')), false, 'collection_ref is required');
  assert.equal(validate(omit(slot(1), 'installment_id')), false, 'installment_id is required');
  assert.equal(validate({ ...slot(1), collection_id: COLLECTION_ID }), false, 'the deprecated shorthand is not inherited');
  assert.equal(validate({ ...slot(1), undeclared: true }), false, 'the canonical shape is closed');
  assert.equal(validate({ ...slot(1), collection_ref: { collection_id: COLLECTION_ID } }), false, 'publisher_domain scopes the ID');
  assert.equal(validate({ ...slot(1), installment_id: '' }), false, 'installment_id is non-empty');

  const schema = readSchema('core/canonical-installment.json');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['installment_id', 'collection_ref']);
  assert.equal(schema.properties.collection_id, undefined, 'no deprecated shorthand is declared');
  assert.equal(schema.properties.installment_id['x-entity'], 'installment');
});

test('a derivative names its source canonically, not by a response-local installment_id', async () => {
  const validate = await compile('/schemas/core/canonical-installment.json');
  const clip = {
    ...slot(1),
    installment_id: 'juniper_vale_slot_1_clip',
    derivative_of: { installment_ref: ref('juniper_vale_slot_1'), type: 'clip' },
  };
  assert.equal(validate(clip), true, errors(validate));
  assert.equal(
    validate({ ...clip, derivative_of: { installment_id: 'juniper_vale_slot_1', type: 'clip' } }),
    false,
    'the legacy response-local form is not accepted',
  );
  assert.equal(validate({ ...clip, derivative_of: { installment_ref: ref('juniper_vale_slot_1') } }), false, 'type is required');
});

test('legacy get_products keeps its installment representation unchanged', async () => {
  const legacy = readSchema('core/installment.json');
  assert.equal(legacy.properties.collection_id.deprecated, true, 'the shorthand stays, deprecated, on the legacy shape');
  assert.equal(legacy.additionalProperties, true, 'the legacy installment stays open');
  assert.deepEqual(legacy.required, ['installment_id'], 'legacy identity does not newly require collection_ref');

  const validateLegacy = await compile('/schemas/core/installment.json');
  assert.equal(validateLegacy({ installment_id: 's1e10', collection_id: COLLECTION_ID }), true, errors(validateLegacy));
  assert.equal(
    validateLegacy({ installment_id: 's1e10_clip', derivative_of: { installment_id: 's1e10', type: 'clip' } }),
    true,
    errors(validateLegacy),
  );

  assert.equal(
    readSchema('core/product.json').properties.installments.items.$ref,
    '/schemas/core/installment.json',
    'the legacy Product still references the legacy installment',
  );
});

test('a canonical product carries installments and requires the collections that scope them', async () => {
  const validate = await compile('/schemas/core/canonical-product.json');
  assert.equal(validate(CANONICAL_PRODUCT), true, errors(validate));
  assert.equal(validate({ ...CANONICAL_PRODUCT, installments: [slot(1), slot(2), slot(3)] }), true, errors(validate));

  assert.equal(
    validate({ ...omit(CANONICAL_PRODUCT, 'collections'), installments: [slot(1)] }),
    false,
    'installments without collections cannot be resolved',
  );
  assert.equal(validate({ ...CANONICAL_PRODUCT, installments: [] }), false, 'an empty array is not run-of-collection');
  assert.equal(
    validate({ ...CANONICAL_PRODUCT, installments: [{ ...slot(1), collection_id: COLLECTION_ID }] }),
    false,
    'a legacy-shaped installment is rejected by the closed canonical product',
  );

  const field = readSchema('core/canonical-product.json').properties.installments;
  assert.equal(field.items.$ref, '/schemas/core/canonical-installment.json');
  assert.equal(field['x-added-in'], '3.3.0');
  assert.equal(field['x-status'], undefined, 'the representation is a stable 3.3 addition, not experimental');
  assert.deepEqual(field['x-adcp-validation'].unique_by, ['collection_ref', 'installment_id']);
  assert.deepEqual(readSchema('core/canonical-product.json').dependencies.installments, ['collections']);
});

test('absence of installments is run-of-collection, and is documented as such', async () => {
  const validate = await compile('/schemas/core/canonical-product.json');
  // A product with collections and no installments is valid and means
  // run-of-collection; nothing in the schema forces slot enumeration.
  assert.equal(validate(CANONICAL_PRODUCT), true, errors(validate));

  const description = readSchema('core/canonical-product.json').properties.installments.description;
  assert.match(description, /run-of-collection/);
  assert.match(description, /not 'no installments known'/);

  const purchase = readSchema('media-buy/product-purchase.json').properties.installments.description;
  assert.match(purchase, /run-of-collection when the product names no installments/);
  assert.match(purchase, /absence never means 'no installments'/);
});

test('installments are requestable through the canonical fields projection', () => {
  const fields = readSchema('media-buy/product-fields.json');
  assert.ok(fields.items.enum.includes('installments'), 'buyers can project installments');
  assert.ok(fields.items.enum.includes('collections'));
  assert.match(fields.description, /requesting installments also returns collections/);
  // The same enum is shared with legacy get_products, where that rule is false.
  assert.match(fields.description, /Legacy get_products shares this enum but not that rule/);
});

test('a purchase names the exact installments it buys', async () => {
  const validate = await compile('/schemas/media-buy/product-purchase.json');
  assert.equal(validate(PURCHASE), true, errors(validate));
  assert.equal(validate({ ...PURCHASE, installments: [ref('juniper_vale_slot_1'), ref('juniper_vale_slot_2')] }), true, errors(validate));

  assert.equal(validate({ ...PURCHASE, installments: [] }), false, 'an empty selection is not a selection');
  assert.equal(
    validate({ ...PURCHASE, installments: [ref('juniper_vale_slot_1'), ref('juniper_vale_slot_1')] }),
    false,
    'a slot cannot be bought twice in one purchase',
  );
  assert.equal(validate({ ...PURCHASE, installments: [{ installment_id: 'juniper_vale_slot_1' }] }), false, 'collection_ref is required');
  assert.equal(
    validate({ ...PURCHASE, installments: [{ ...ref('juniper_vale_slot_1'), note: 'rider' }] }),
    false,
    'an undeclared member cannot ride inside the digest',
  );
  assert.equal(validate({ ...PURCHASE, installments: ['juniper_vale_slot_1'] }), false, 'a bare ID is not a canonical reference');

  const field = readSchema('media-buy/product-purchase.json').properties.installments;
  assert.equal(field.items.$ref, '/schemas/core/canonical-installment-ref.json');
  // Inside the terms_digest preimage, equal bought sets must serialize to
  // equal bytes, so the array carries the same ordering rule definition_pins
  // does. JCS sorts object members but never reorders arrays.
  assert.equal(field['x-adcp-validation'].ordered_by, 'jcs_bytes_of_entry');
  assert.match(field.description, /ordered by the JCS bytes of the reference/);
  assert.match(field.description, /MUST reject a proposal carrying it rather than ignore it/);
  assert.match(field.description, /it does not bind what the seller later publishes under those identifiers/);
  assert.equal(field['x-status'], 'experimental');
  assert.equal(field['x-added-in'], '3.3.0');
  assert.match(field.description, /media_buy\.installment_selection/);
  assert.match(field.description, /MUST NOT emit it to a caller negotiating below AdCP 3\.3/);
});

test('buy_products input cannot select installments; selection is a proposal surface', () => {
  const input = readSchema('media-buy/product-purchase-input.json');
  assert.equal(input.properties.installments, undefined, 'direct purchase has no installment selection yet');
});

test('selected installments travel inside commercial_terms and move terms_digest', async () => {
  const validate = await compile('/schemas/media-buy/commercial-terms.json');
  const twoSlots = termsWith([ref('juniper_vale_slot_1'), ref('juniper_vale_slot_2')]);
  const dropped = termsWith([ref('juniper_vale_slot_1')]);
  const swapped = termsWith([ref('juniper_vale_slot_1'), ref('juniper_vale_slot_3')]);
  const runOfCollection = termsWith(undefined);

  for (const terms of [twoSlots, dropped, swapped, runOfCollection]) {
    assert.equal(validate(terms), true, errors(validate));
  }

  assert.match(termsDigest(twoSlots), /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(
    termsDigest(twoSlots),
    termsDigest(termsWith([ref('juniper_vale_slot_1'), ref('juniper_vale_slot_2')])),
    'equal terms, equal digest',
  );
  assert.notEqual(termsDigest(twoSlots), termsDigest(dropped), 'dropping a slot changes the digest');
  assert.notEqual(termsDigest(twoSlots), termsDigest(runOfCollection), 'naming slots differs from buying the product as offered');

  // JCS sorts object members but never reorders arrays, so without the
  // ordering rule two identical bought sets would produce different digests —
  // and two commercially identical drafts could pass the alternatives
  // distinctness check on permutation alone.
  const permuted = termsWith([ref('juniper_vale_slot_2'), ref('juniper_vale_slot_1')]);
  assert.notEqual(termsDigest(twoSlots), termsDigest(permuted), 'array order reaches the digest');
  assert.ok(
    readSchema('media-buy/product-purchase.json').properties.installments['x-adcp-validation'].ordered_by,
    'so the array declares a canonical order',
  );

  const pattern = readSchema('core/canonical-proposal.json').properties.terms_digest.pattern;
  assert.ok(new RegExp(pattern).test(termsDigest(twoSlots)), 'the digest fits the proposal field');
});

test('a committed proposal binds the exact slots through its digest', async () => {
  const validate = await compile('/schemas/core/canonical-proposal.json');
  const commercial_terms = termsWith([ref('juniper_vale_slot_1'), ref('juniper_vale_slot_2')]);
  const committed = {
    proposal_id: 'creatorloop_committed_01',
    proposal_kind: 'new_media_buy',
    proposal_status: 'committed',
    expires_at: '2026-11-10T17:00:00Z',
    name: 'Juniper Vale December slots',
    commercial_terms,
    terms_digest: termsDigest(commercial_terms),
  };
  assert.equal(validate(committed), true, errors(validate));

  // The accepted snapshot is the same envelope, so the slots survive acceptance.
  const accepted = {
    ...committed,
    proposal_id: 'creatorloop_accepted_01',
    parent_proposal_id: committed.proposal_id,
    proposal_status: 'accepted',
    media_buy_id: 'mb_creatorloop_01',
    accepted_at: '2026-11-05T12:00:00Z',
  };
  assert.equal(validate(accepted), true, errors(validate));
  assert.deepEqual(
    accepted.commercial_terms.purchases[0].installments.map(entry => entry.installment_id),
    ['juniper_vale_slot_1', 'juniper_vale_slot_2'],
  );
});

test('installment_changes expresses a drop and a swap with an explicit verb', async () => {
  const validate = await compile('/schemas/core/installment-change-set.json');
  assert.equal(validate([change('juniper_vale_slot_2', 'omit')]), true, errors(validate));
  assert.equal(
    validate([change('juniper_vale_slot_2', 'omit'), change('juniper_vale_slot_3', 'include')]),
    true,
    errors(validate),
  );

  assert.equal(validate([]), false, 'an empty change set is not a change');
  assert.equal(validate([{ installment_ref: ref('juniper_vale_slot_2'), action: 'omit' }]), false, 'product_id names the purchase');
  assert.equal(validate([{ product_id: PRODUCT_ID, action: 'omit' }]), false, 'installment_ref is required');
  // A drop that silently defaulted to include is the expensive failure, so
  // the verb is required where product-refinement.json lets it default.
  assert.equal(validate([{ product_id: PRODUCT_ID, installment_ref: ref('juniper_vale_slot_2') }]), false, 'action is required');
  assert.equal(validate([change('juniper_vale_slot_2', 'replace')]), false, 'the action verbs match product_changes');
  assert.equal(
    validate([{ ...change('juniper_vale_slot_2', 'omit'), ask: 'please' }]),
    false,
    'entries are closed',
  );

  const schema = readSchema('core/installment-change-set.json');
  assert.deepEqual(schema.items.properties.action.enum, ['include', 'omit']);
  assert.equal(schema.items.properties.action.default, undefined, 'no default to fall through to');
  assert.deepEqual(schema.items.required, ['product_id', 'installment_ref', 'action']);
  assert.deepEqual(schema['x-adcp-validation'].unique_by, ['product_id', 'installment_ref']);
  assert.equal(schema['x-status'], 'experimental');
  assert.equal(schema['x-added-in'], '3.3.0');
});

test('a contradictory pair is a seller-rejected MUST, not a structural impossibility', async () => {
  const validate = await compile('/schemas/core/installment-change-set.json');
  // product-change-map.json gets this for free from object keys. A list
  // cannot, so the schema accepts the contradiction and the protocol forbids
  // it — the docs and the description must say that, not claim otherwise.
  const contradiction = [change('juniper_vale_slot_2', 'omit'), change('juniper_vale_slot_2', 'include')];
  assert.equal(validate(contradiction), true, 'JSON Schema cannot express tuple uniqueness');
  // uniqueItems still catches the literal duplicate for free.
  assert.equal(validate([change('juniper_vale_slot_2', 'omit'), change('juniper_vale_slot_2', 'omit')]), false, 'literal duplicate');

  const description = readSchema('core/installment-change-set.json').description;
  assert.ok(
    !/cannot be represented/.test(description),
    'the description must not claim a guarantee the shape does not give',
  );
  assert.match(description, /entries MUST be unique by \(product_id, installment_ref\)/);
  assert.match(description, /INVALID_REQUEST/);

  // The buyer-facing error table has to carry the same rule, or an
  // implementer reading only the docs never learns it.
  const refine = readDoc('media-buy/task-reference/refine_proposals.mdx');
  assert.match(refine, /repeat the same \`\(product_id, installment_ref\)\`/);
  const guide = readDoc('media-buy/product-discovery/collections-and-installments.mdx');
  assert.ok(!/cannot ask for an installment to be both kept and dropped/.test(guide));
});

test('references covered by a digest or sent by a buyer use the closed canonical shape', async () => {
  const validate = await compile('/schemas/core/canonical-installment-ref.json');
  assert.equal(validate(ref('juniper_vale_slot_1')), true, errors(validate));
  assert.equal(validate({ ...ref('juniper_vale_slot_1'), note: 'x' }), false, 'extra members would ride inside terms_digest');
  assert.equal(
    validate({ collection_ref: { ...COLLECTION_REF, note: 'x' }, installment_id: 'a' }),
    false,
    'the nested collection identity is closed too',
  );
  assert.equal(validate({ collection_ref: { ...COLLECTION_REF }, installment_id: 'a'.repeat(256) }), false, 'bounded');

  // The open core/installment-ref.json stays as-is for seller-emitted
  // delivery rows, where an extra member is harmless.
  assert.equal(readSchema('core/installment-ref.json').additionalProperties, true);
  assert.equal(
    readSchema('core/installment-delivery-metrics.json').allOf[1].properties.installment_ref.$ref,
    '/schemas/core/installment-ref.json',
  );
});

test('installment_changes is a revise-only refinement dimension', async () => {
  const validate = await compile('/schemas/media-buy/proposal-refinement.json');
  const installment_changes = [change('juniper_vale_slot_2', 'omit')];

  assert.equal(validate({ proposal_id: 'p1', action: 'revise', installment_changes }), true, errors(validate));
  assert.equal(
    validate({ proposal_id: 'p1', action: 'revise', installment_changes, product_changes: { [PRODUCT_ID]: 'include' } }),
    true,
    errors(validate),
  );
  assert.equal(validate({ proposal_id: 'p1', action: 'finalize', installment_changes }), false, 'finalize changes no terms');
  assert.equal(validate({ proposal_id: 'p1', action: 'extend_hold', installment_changes }), false, 'extend_hold changes no terms');

  const field = readSchema('media-buy/proposal-refinement.json').properties.installment_changes;
  // A plain $ref, like product_changes: the projected tool schema keeps the
  // change set strictly validated rather than stubbing it to a loose array.
  assert.equal(field.$ref, '/schemas/core/installment-change-set.json');
  assert.equal(field['x-adcp-schema-uri'], undefined);
  // Adding a product and naming its slots has to be one round trip, and the
  // membership check has to precede reference resolution.
  assert.match(field.description, /product_changes includes in the same refinement/);
  assert.match(field.description, /BEFORE resolving any installment_ref/);
  assert.match(field.description, /A swap is not atomic/);
  assert.equal(field['x-status'], 'experimental');
  assert.equal(field['x-added-in'], '3.3.0');
  assert.match(field.description, /REFERENCE_NOT_FOUND/);
  assert.match(field.description, /INVALID_REQUEST/);
  assert.match(field.description, /constraint_unsatisfiable/);
});

test('unsatisfied installment changes are reported back on partial and unable results', async () => {
  const validate = await compile('/schemas/media-buy/refine-proposals-response.json');
  const response = {
    status: 'completed',
    products: [CANONICAL_PRODUCT],
    results: [
      {
        source_proposal_id: 'creatorloop_draft_01',
        outcome: 'partial',
        reason_code: 'constraint_unsatisfiable',
        reason: 'The January slot is already committed to another advertiser.',
        unsatisfied_installment_changes: [change('juniper_vale_slot_3', 'include')],
        proposals: [
          {
            proposal_id: 'creatorloop_draft_02',
            parent_proposal_id: 'creatorloop_draft_01',
            proposal_kind: 'new_media_buy',
            proposal_status: 'draft',
            name: 'Juniper Vale December slot',
            commercial_terms: termsWith([ref('juniper_vale_slot_1')]),
            terms_digest: termsDigest(termsWith([ref('juniper_vale_slot_1')])),
          },
        ],
      },
    ],
  };
  assert.equal(validate(response), true, errors(validate));

  response.results[0].unsatisfied_installment_changes = [];
  assert.equal(validate(response), false, 'an empty echo is not a report');

  // An unsatisfied installment change is a witness for constraint_unsatisfiable
  // on its own, so a seller that fails only an installment action does not have
  // to invent an empty unsatisfied_constraints array.
  const installmentOnly = structuredClone(response);
  installmentOnly.results[0].unsatisfied_installment_changes = [change('juniper_vale_slot_3', 'include')];
  assert.equal(validate(installmentOnly), true, errors(validate));
  delete installmentOnly.results[0].unsatisfied_installment_changes;
  assert.equal(validate(installmentOnly), false, 'constraint_unsatisfiable needs a typed witness');

  // The echo belongs to results that fell short, never to a clean revision or a
  // finalize, which changes no terms at all.
  const revised = structuredClone(response);
  revised.results[0] = {
    source_proposal_id: 'creatorloop_draft_01',
    outcome: 'revised',
    proposals: response.results[0].proposals,
    unsatisfied_installment_changes: [change('juniper_vale_slot_3', 'include')],
  };
  assert.equal(validate(revised), false, 'a revised result satisfied every change');
  delete revised.results[0].unsatisfied_installment_changes;
  assert.equal(validate(revised), true, errors(validate));

  const field = readSchema('media-buy/refine-proposals-response.json')
    .properties.results.items.properties.unsatisfied_installment_changes;
  assert.equal(field.allOf[0].$ref, '/schemas/core/installment-change-set.json');
  assert.equal(field['x-status'], 'experimental');
  assert.match(field.description, /partial or unable/);
});

test('declaring the installment_changes dimension requires the experimental feature id', async () => {
  const schema = readSchema('protocol/get-adcp-capabilities-response.json');
  const dimensions = schema.properties.media_buy.properties.proposal_refinement
    .properties.supported_dimensions.items.enum;
  assert.ok(dimensions.includes('installment_changes'));
  assert.ok(dimensions.includes('product_changes'), 'the existing dimensions are preserved');

  const gate = schema.allOf.find(rule => (
    rule.then?.properties?.experimental_features?.contains?.const === 'media_buy.installment_selection'
  ));
  assert.ok(gate, 'a declared dimension must be listed in experimental_features');
  assert.deepEqual(
    gate.if.properties.media_buy.properties.proposal_refinement.properties.supported_dimensions.contains,
    { const: 'installment_changes' },
  );

  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  const base = {
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    media_buy: {
      lifecycle_tools: ['list_products', 'request_proposals', 'refine_proposals', 'accept_proposal'],
      proposal_refinement: { supported_dimensions: ['product_changes', 'installment_changes'] },
    },
  };
  assert.equal(validate(base), false, 'undeclared experimental surface');
  assert.equal(validate({ ...base, experimental_features: ['media_buy.installment_selection'] }), true, errors(validate));
});

test('the documentation records the closed gap, the live boundaries, and the registry row', () => {
  const limitations = readDoc('reference/known-limitations.mdx');
  assert.ok(
    !/\*\*No `installments`\.\*\*/.test(limitations),
    'the compact-lifecycle installments gap is closed, not restated',
  );
  assert.match(limitations, /`installments` was the other absent member and shipped in 3\.3/);
  assert.match(limitations, /media_buy\.installment_selection/);
  // The residual bounds are the point of the entry: they must survive edits
  // that tidy the closure notice.
  assert.match(limitations, /Selection is a negotiation surface, not a discovery one/);
  assert.match(limitations, /canonical and legacy installment shapes will stay forked/);
  assert.match(limitations, /reference seller does not yet negotiate slots/);

  const experimental = readDoc('reference/experimental-status.mdx');
  assert.match(experimental, /^\| `media_buy\.installment_selection` \|/m, 'the feature id has a registry row');

  const guide = readDoc('media-buy/product-discovery/collections-and-installments.mdx');
  assert.match(guide, /## Installments in the compact lifecycle/);
  assert.match(guide, /### Absence is run-of-collection, not "unknown"/);
  assert.match(guide, /buyers MUST reject a product whose installment names a collection its own selectors do not/);
  assert.match(guide, /Three seller postures are visible from capabilities/);

  const refine = readDoc('media-buy/task-reference/refine_proposals.mdx');
  assert.match(refine, /## Change installments \(experimental\)/);
  assert.match(refine, /unsatisfied_installment_changes/);
  assert.match(refine, /availability probe/, 'the oracle warning covers slot availability, not just price');

  const accept = readDoc('media-buy/task-reference/accept_proposal.mdx');
  // The digest binds identifiers, not what is published under them. Claiming
  // more than that is the one thing a buyer would build on and be wrong.
  assert.match(accept, /cannot be given a different \*set of slot identifiers\*/);
  assert.match(accept, /What the digest does \*\*not\*\* bind/);
  assert.match(readDoc('media-buy/specification.mdx'), /installment references in \`purchases\[\]\.installments\`/);
  assert.match(limitations, /binds which slots were bought, not what is published under them/);

  assert.match(readDoc('reference/whats-new-in-3-3.mdx'), /### Installments on the compact product lifecycle/);
  assert.match(readDoc('media-buy/task-reference/list_products.mdx'), /only meaningful inside a projection that asked for the field/);

  const migration = readDoc('reference/migration/3-2-to-3-3.mdx');
  assert.match(migration, /### Installments on the compact product lifecycle/);
});
