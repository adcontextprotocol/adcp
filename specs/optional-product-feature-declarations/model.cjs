// Nonoperative proposal model. No shipping runner/output contract is changed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const featureSchema = require('./features.schema.json');
const controllerSchema = require('./controller.schema.json');
const features = Object.keys(featureSchema.properties).map(name => name.slice('supports_'.length));

async function validators() {
  const ajv = new Ajv({ strict: false, allErrors: true, loadSchema: async uri => {
    const released = 'https://adcontextprotocol.org/schemas/3.2.5/';
    if (uri.startsWith(released) && !uri.includes('..')) return JSON.parse(fs.readFileSync(path.join(__dirname, '../../dist/schemas/3.2.5', uri.slice(released.length)), 'utf8'));
    if (!uri.startsWith('/schemas/') || uri.includes('..')) throw new Error(`Unrecognized source schema: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../static/schemas/source', uri.slice('/schemas/'.length)), 'utf8'));
  } });
  addFormats(ajv);
  const product = await ajv.compileAsync({ $ref: '/schemas/core/product.json' });
  const simulated = await ajv.compileAsync({ ...controllerSchema, $ref: '#/definitions/simulated' });
  return {
    declaration: await ajv.compileAsync({
      ...require('../../static/schemas/source/core/media-buy-features.json'),
      $id: undefined,
      properties: { ...require('../../static/schemas/source/core/media-buy-features.json').properties, ...featureSchema.properties },
    }), product, simulated,
    collectionSelection: await ajv.compileAsync({ $ref: '/schemas/core/collection-selection.json' }),
    deliveryMetrics: await ajv.compileAsync({ $ref: '/schemas/core/delivery-metrics.json' }),
    deliveryRequest: await ajv.compileAsync({ $ref: '/schemas/media-buy/get-media-buy-delivery-request.json' }),
    formatPackage: await ajv.compileAsync(require('../../static/schemas/source/media-buy/get-media-buy-delivery-response.json')
      .properties.media_buy_deliveries.items.properties.by_package.items),
    oldFeatures: await ajv.compileAsync(require('../../dist/schemas/3.2.5/core/media-buy-features.json')),
    params: ajv.compile({ ...controllerSchema, $ref: '#/definitions/params' }),
  };
}

// UTF-8 ordering with a lossless tie-break for schema-valid lone-surrogate
// strings that Buffer encodes to the same replacement bytes. No ID rewriting.
function compareWireStrings(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) || (a < b ? -1 : a > b ? 1 : 0);
}

// Evidence-only normalizer for schema-valid concrete selectors. This is not an
// SDK predicate/capture API or qualification of the proposed foundation contract.
function collectionPairs(selectors) {
  const pairs = new Map();
  for (const selector of selectors ?? []) for (const id of selector.collection_ids ?? []) {
    const pair = [selector.publisher_domain, id];
    pairs.set(JSON.stringify(pair), pair);
  }
  return [...pairs.values()].sort((a, b) =>
    compareWireStrings(a[0], b[0]) || compareWireStrings(a[1], b[1]));
}

// These predicates are proposed fixture qualification, not universal new product
// requirements. Owner channel/host evidence is separate from the product shape.
function qualifies(feature, product, ownerEvidence) {
  const report = product.reporting_capabilities ?? {};
  switch (feature) {
    case 'collection_selection': return collectionPairs(product.collections).length >= 2 && product.collection_targeting_allowed === true;
    case 'collection_default_materialization': return collectionPairs(product.collections).length >= 1;
    case 'fixed_collection_bundles': return collectionPairs(product.collections).length >= 2 && product.collection_targeting_allowed !== true;
    case 'owner_sold_channel_carriage': return Boolean(ownerEvidence
      && ownerEvidence.product_id === product.product_id
      && ownerEvidence.kind === 'channel'
      && ownerEvidence.owner_domain !== ownerEvidence.host_domain
      && collectionPairs(product.collections).some(([domain, id]) => domain === ownerEvidence.owner_domain && id === ownerEvidence.collection_id)
      && product.publisher_properties?.some(s => s.publisher_domain === ownerEvidence.host_domain));
    case 'format_breakdown': return report.supports_format_breakdown === true;
    case 'time_based_views': return report.available_metrics?.includes('time_based_views') === true;
    default: return false;
  }
}

// Catalog may be null when no wholesale surface exists. Exceptions after an
// attempted advertised operation are terminal; this model never falls back.
async function evaluate({ feature, capabilities = {}, catalog = [], ownerEvidence,
  harness = true, sandbox = true, operation = true, prepare, exercise = async () => true, validate }) {
  if (!features.includes(feature)) throw new Error('Unknown model feature');
  if (capabilities.media_buy !== undefined && (!capabilities.media_buy || typeof capabilities.media_buy !== 'object' || Array.isArray(capabilities.media_buy))) {
    return { state: 'commitment_violation', reason: 'invalid_declaration' };
  }
  const declarations = capabilities.media_buy?.features === undefined ? {} : capabilities.media_buy.features;
  if (!validate.declaration(declarations)) return { state: 'commitment_violation', reason: 'invalid_declaration' };
  if (!sandbox) return { state: 'harness_gap', reason: 'sandbox_precondition' };
  const promised = declarations[`supports_${feature}`] === true;
  if (catalog && catalog.some(p => !validate.product(p))) return { state: 'behavior_violation', reason: 'invalid_catalog' };
  let product = catalog?.filter(p => qualifies(feature, p, ownerEvidence))
    .sort((a, b) => compareWireStrings(a.product_id, b.product_id))[0];
  let route = 'catalog';
  if (!product && !promised) return { state: 'coverage_gap', reason: catalog === null ? 'no_wholesale_surface' : 'fixture_unsatisfied' };
  if (!product) {
    if (!harness || typeof prepare !== 'function') return { state: 'harness_gap', reason: 'missing_runner_contract' };
    if (!operation) return { state: 'commitment_violation', reason: 'missing_promised_operation' };
    route = 'prepared';
    const params = { feature, fixture_id: `proposal-${feature}` };
    let response;
    try { response = await prepare(params); }
    catch { return { state: 'commitment_violation', reason: 'setup_transport' }; }
    if (response?.success !== true) return { state: 'commitment_violation', reason: 'setup_refused', response };
    if (!validate.simulated(response.simulated)
      || response.simulated.feature !== feature || response.simulated.fixture_id !== params.fixture_id
      || !qualifies(feature, response.simulated.product, ownerEvidence)) {
      return { state: 'commitment_violation', reason: 'invalid_qualified_setup' };
    }
    product = response.simulated.product;
  }
  const commitment = !promised || route === 'prepared' ? undefined
    : !harness || typeof prepare !== 'function' ? 'unverified_missing_runner_contract'
    : !operation ? 'violation_missing_promised_operation' : 'untested_preparation';
  try {
    return await exercise(product) ? { state: 'applicable', route, product_id: product.product_id,
      ...(commitment && { commitment }) }
      : { state: 'behavior_violation', reason: 'selected_behavior', route, ...(commitment && { commitment }) };
  } catch { return { state: 'behavior_violation', reason: 'selected_protocol', route, ...(commitment && { commitment }) }; }
}

module.exports = { features, validators, collectionPairs, qualifies, evaluate };
