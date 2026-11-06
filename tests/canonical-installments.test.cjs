/**
 * Contract test for installments on the compact product lifecycle (#8230).
 *
 * The canonical Product can name the specific episodes, issues, airings or
 * creator slots it sells. Each assertion below pins one property that a later
 * change could quietly drop:
 *
 * - the canonical installment is identified by the (collection_ref,
 *   installment_id) tuple alone, so the deprecated collection_id shorthand
 *   cannot leak into the closed shape;
 * - legacy get_products keeps that shorthand, because removing it is a major
 *   change and the legacy Product is not what the compact lifecycle reads;
 * - absence of Product.installments means run-of-collection, not "unknown".
 *
 * Naming the exact installments a purchase buys, and refining them, was merged
 * and then withdrawn to 4.0 (adcp#8501): commercial_terms is closed in 3.x.
 * tests/withdrawn-to-4-0.test.cjs pins that absence.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');


const ROOT = path.join(__dirname, '..');
const SCHEMA_BASE_DIR = path.join(ROOT, 'static/schemas/source');
const DOCS = path.join(ROOT, 'docs');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), 'utf8'));
}

function readDoc(relativePath) {
  return fs.readFileSync(path.join(DOCS, relativePath), 'utf8');
}

// Validation runs against the published schemas (dist/schemas/latest).
async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
  return readBuiltSchema(uri);
}

const compiled = new Map();
function compile(schemaId) {
  if (!compiled.has(schemaId)) {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(ajv);
    compiled.set(schemaId, ajv.compileAsync(readBuiltSchema(schemaId)));
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
});

test('installments are requestable through the canonical fields projection', () => {
  const fields = readSchema('media-buy/product-fields.json');
  assert.ok(fields.items.enum.includes('installments'), 'buyers can project installments');
  assert.ok(fields.items.enum.includes('collections'));
  assert.match(fields.description, /requesting installments also returns collections/);
  // The same enum is shared with legacy get_products, where that rule is false.
  assert.match(fields.description, /Legacy get_products shares this enum but not that rule/);
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

test('the documentation records the closed gap, the live boundaries, and the withdrawn selection', () => {
  const limitations = readDoc('reference/known-limitations.mdx');
  assert.ok(
    !/\*\*No `installments`\.\*\*/.test(limitations),
    'the compact-lifecycle installments gap is closed, not restated',
  );
  assert.match(limitations, /`installments` was the other absent member and shipped in 3\.3/);
  // The residual bounds are the point of the entry: they must survive edits
  // that tidy the closure notice.
  assert.match(limitations, /A purchase buys the product as offered; it cannot name slots/);
  assert.match(limitations, /canonical and legacy installment shapes will stay forked/);

  const experimental = readDoc('reference/experimental-status.mdx');
  assert.doesNotMatch(experimental, /media_buy\.installment_selection/, 'the withdrawn feature id has no registry row');

  const guide = readDoc('media-buy/product-discovery/collections-and-installments.mdx');
  assert.match(guide, /## Installments in the compact lifecycle/);
  assert.match(guide, /### Absence is run-of-collection, not "unknown"/);
  assert.match(guide, /buyers MUST reject a product whose installment names a collection its own selectors do not/);
  assert.match(guide, /### Buying a product that names installments/);

  assert.match(readDoc('reference/whats-new-in-3-3.mdx'), /#{2,3} Installments on the compact product lifecycle/);
  assert.match(readDoc('media-buy/task-reference/list_products.mdx'), /only meaningful inside a projection that asked for the field/);

  const migration = readDoc('reference/migration/3-2-to-3-3.mdx');
  assert.match(migration, /### Installments on the compact product lifecycle/);
});
