const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

describe('portable demographic targeting', () => {
  let validatePredicate;
  let validateTargeting;
  let validateCapability;
  let validateResolution;
  let validateDefinition;
  let validateListing;

  before(async () => {
    [validatePredicate, validateTargeting, validateCapability, validateResolution, validateDefinition, validateListing] = await Promise.all([
      compile('/schemas/core/demographic-predicate.json'),
      compile('/schemas/core/targeting.json'),
      compile('/schemas/core/demographic-targeting-capability.json'),
      compile('/schemas/core/demographic-targeting-resolution.json'),
      compile('/schemas/core/signal-definition.json'),
      compile('/schemas/core/signal-listing.json'),
    ]);
  });

  it('accepts inclusive closed and open age bounds only with explicit unknown handling', () => {
    assert.equal(validatePredicate({ age: { min: 21, max: 35, include_unknown: false } }), true);
    assert.equal(validatePredicate({ age: { min: 65, include_unknown: true } }), true);
    assert.equal(validatePredicate({ age: { max: 17, include_unknown: false } }), true);

    assert.equal(validatePredicate({ age: { min: 21, max: 35 } }), false, 'include_unknown has no default');
    assert.equal(validatePredicate({ age: { include_unknown: false } }), false, 'at least one bound is required');
    assert.equal(validatePredicate({ age: [{ min: 18, max: 24 }, { min: 35, max: 44 }] }), false, 'disjoint arrays are not a predicate');
  });

  it('composes demographic selection with age eligibility without admitting unknown ages', () => {
    assert.equal(validateTargeting({
      demographics: { age: { min: 21, max: 35, include_unknown: false } },
      age_restriction: { min: 21, verification_required: true },
    }), true);
    assert.equal(validateTargeting({
      demographics: { age: { min: 21, max: 35, include_unknown: true } },
      age_restriction: { min: 21 },
    }), false);
  });

  it('requires the execution detail promised by each product mode', () => {
    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        unknown_handling: 'selectable',
      },
    }), true);

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        unknown_handling: 'selectable',
      },
    }), false, 'continuous bounds require the supported domain');

    assert.equal(validateCapability({
      age: {
        execution_modes: ['enumerated_intervals'],
        unknown_handling: 'always_excluded',
        intervals: [
          { interval_id: 'age_18_24', age: { min: 18, max: 24, include_unknown: false } },
          { interval_id: 'age_25_34', age: { min: 25, max: 34, include_unknown: false } },
        ],
      },
    }), true);

    assert.equal(validateCapability({
      age: {
        execution_modes: ['enumerated_intervals'],
        unknown_handling: 'always_excluded',
      },
    }), false, 'enumerated mode requires its authoritative interval catalog');
  });

  it('requires age-sensitive signals to declare the age restricted attribute', () => {
    const definition = {
      id: 'adults_25_34',
      name: 'Adults 25–34',
      value_type: 'binary',
      demographic_predicate: { age: { min: 25, max: 34, include_unknown: false } },
    };
    assert.equal(validateDefinition(definition), false);
    assert.equal(validateDefinition({ ...definition, restricted_attributes: ['age'] }), true);

    const listing = {
      signal_ref: { scope: 'product', signal_id: 'adults_25_34' },
      name: 'Adults 25–34',
      value_type: 'binary',
      demographic_predicate: { age: { min: 25, max: 34, include_unknown: false } },
    };
    assert.equal(validateListing(listing), false);
    assert.equal(validateListing({ ...listing, restricted_attributes: ['age'] }), true);
  });

  it('validates lossless exact readback for every execution mode', () => {
    const requested = { age: { min: 21, max: 35, include_unknown: false } };
    const base = { requested, applied: requested, equivalent: true };

    assert.equal(validateResolution({ ...base, execution: { type: 'continuous_bounds' } }), true);
    assert.equal(validateResolution({
      ...base,
      execution: { type: 'enumerated_intervals', interval_ids: ['age_21_24', 'age_25_34', 'age_35'] },
    }), true);
    assert.equal(validateResolution({
      requested: { age: { min: 25, max: 34, include_unknown: false } },
      applied: { age: { min: 25, max: 34, include_unknown: false } },
      equivalent: true,
      execution: {
        type: 'signals',
        signal_refs: [{ scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'adults_25_34' }],
      },
    }), true);
  });

  it('makes every non-equivalent readback explain the difference', () => {
    const nonExact = {
      requested: { age: { min: 21, max: 35, include_unknown: false } },
      applied: { age: { min: 25, max: 34, include_unknown: false } },
      equivalent: false,
      execution: { type: 'enumerated_intervals', interval_ids: ['age_25_34'] },
    };
    assert.equal(validateResolution(nonExact), false);
    assert.equal(validateResolution({ ...nonExact, difference_reason: 'Narrower alternative', buyer_approved: false }), false);
    assert.equal(validateResolution({ ...nonExact, difference_reason: 'Buyer-approved narrower alternative', buyer_approved: true }), true);
  });

  it('locks the request, product, capability-rollup, and package-readback schema paths', () => {
    const targeting = readSchema('/schemas/core/targeting.json');
    const product = readSchema('/schemas/core/product.json');
    const capabilities = readSchema('/schemas/protocol/get-adcp-capabilities-response.json');
    const packageSchema = readSchema('/schemas/core/package.json');
    const getMediaBuys = readSchema('/schemas/media-buy/get-media-buys-response.json');

    assert.equal(targeting.properties.demographics.$ref, '/schemas/core/demographic-predicate.json');
    assert.equal(product.properties.demographic_targeting.$ref, '/schemas/core/demographic-targeting-capability.json');
    assert.equal(capabilities.properties.media_buy.properties.execution.properties.targeting.properties.demographics.properties.supported.type, 'boolean');
    assert.equal(packageSchema.properties.demographic_targeting_resolution.$ref, '/schemas/core/demographic-targeting-resolution.json');
    assert.equal(
      getMediaBuys.properties.media_buys.items.properties.packages.items.properties.demographic_targeting_resolution.$ref,
      '/schemas/core/demographic-targeting-resolution.json'
    );
  });
});
