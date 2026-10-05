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
  let validateIntent;
  let validateTargeting;
  let validateCapability;
  let validateResolution;
  let validateDefinition;
  let validateListing;
  let validateInput;
  let validateEnrichment;
  let validateOverlaySupport;
  let validateOverlayRequirements;

  before(async () => {
    [validatePredicate, validateIntent, validateTargeting, validateCapability, validateResolution, validateDefinition, validateListing, validateInput, validateEnrichment, validateOverlaySupport, validateOverlayRequirements] = await Promise.all([
      compile('/schemas/core/demographic-predicate.json'),
      compile('/schemas/core/demographic-targeting-intent.json'),
      compile('/schemas/core/targeting.json'),
      compile('/schemas/core/demographic-targeting-capability.json'),
      compile('/schemas/core/demographic-targeting-resolution.json'),
      compile('/schemas/core/signal-definition.json'),
      compile('/schemas/core/signal-listing.json'),
      compile('/schemas/core/targeting-input.json'),
      compile('/schemas/core/signal-definition-enrichment.json'),
      compile('/schemas/core/targeting-overlay-support.json'),
      compile('/schemas/core/targeting-overlay-requirements.json'),
    ]);
  });

  const gender = { values: ['female', 'non_binary'], include_unknown: false };
  const age = { min: 18, max: 55, include_unknown: false };
  const nativeResolution = () => ({
    requested: { gender: structuredClone(gender) },
    applied: { gender: structuredClone(gender) },
    equivalent: true,
    execution: { type: 'gender_values' },
  });

  it('requires the experimental feature declaration only for affirmative gender support', async () => {
    const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
    const capability = {
      status: 'completed',
      adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      supported_protocols: ['media_buy'],
    };
    assert.equal(validate(capability), true, JSON.stringify(validate.errors));
    const withDemographics = demographics => ({ ...capability,
      media_buy: { execution: { targeting: { demographics } } } });
    assert.equal(validate(withDemographics({ supported: true })), true);
    assert.equal(validate(withDemographics({ supported: true, gender: { supported: false } })), true);
    const genderSupport = withDemographics({ supported: true, gender: { supported: true } });
    assert.equal(validate(genderSupport), false);
    assert.equal(validate({ ...genderSupport, experimental_features: ['media_buy.daypart_granularity'] }), false);
    assert.equal(validate({ ...genderSupport, experimental_features: ['media_buy.gender_targeting'] }), true,
      JSON.stringify(validate.errors));
  });

  it('accepts gender-only and mixed intent without inventing age or defaulting unknown membership', () => {
    for (const validate of [validatePredicate, validateIntent]) {
      assert.equal(validate({ gender }), true, JSON.stringify(validate.errors));
      assert.equal(validate({ age, gender }), true);
      assert.equal(validate({}), false);
      assert.equal(validate({ other_dimension: {} }), false);
      for (const invalid of [
        { values: [], include_unknown: false },
        { values: ['female', 'female'], include_unknown: false },
        { values: ['other'], include_unknown: false },
        { values: ['unknown'], include_unknown: false },
        { values: ['non_binary'] },
        { values: ['non-binary'], include_unknown: false },
        null,
      ]) assert.equal(validate({ gender: invalid }), false, JSON.stringify(invalid));
    }
    assert.equal(validateTargeting({ demographics: { gender: { ...gender, include_unknown: true } }, age_restriction: { min: 21, verification_required: true } }), true,
      'an age eligibility floor does not constrain unknown gender');
  });

  it('advertises optional product gender subsets and explicit execution/unknown policies', () => {
    const capability = { gender: { execution_modes: ['native', 'signals'], values: ['non_binary'], unknown_handling: 'selectable' } };
    assert.equal(validateCapability(capability), true);
    for (const change of [
      { values: [] }, { values: ['female', 'female'] }, { values: ['unknown'] },
      { execution_modes: [] }, { execution_modes: ['continuous_bounds'] },
      { unknown_handling: 'unspecified' },
    ]) assert.equal(validateCapability({ gender: { ...capability.gender, ...change } }), false);
    for (const key of ['values', 'execution_modes', 'unknown_handling']) {
      const invalid = structuredClone(capability); delete invalid.gender[key];
      assert.equal(validateCapability(invalid), false);
    }
    assert.equal(validateOverlaySupport({ demographics: { gender: true } }), true);
    assert.equal(validateOverlayRequirements({ demographics: { age: true, gender: true } }), true);
    assert.equal(validateOverlayRequirements({ demographics: {} }), false);
  });

  it('retains whole-demographics replacement and request-only null clear', () => {
    assert.equal(validateInput({ demographics: { age, gender } }), true);
    assert.equal(validateInput({ demographics: { gender } }), true);
    assert.equal(validateInput({ demographics: null }), true);
    assert.equal(validateTargeting({ demographics: null }), false);
    for (const demographics of [{ age, gender: null }, { age: null, gender }]) {
      assert.equal(validateInput({ demographics }), false, 'nested dimension null is not a recursive patch');
    }
  });

  it('reports gender-only native/signals and mixed per-dimension execution with matching dimensions', () => {
    assert.equal(validateResolution(nativeResolution()), true, JSON.stringify(validateResolution.errors));
    const signal = { scope: 'product', signal_id: 'gender_selection' };
    const signalResolution = { ...nativeResolution(), execution: { type: 'signals', signal_refs: [signal] } };
    assert.equal(validateResolution(signalResolution), true);
    for (const ageExecution of [
      { type: 'continuous_bounds' },
      { type: 'enumerated_intervals', interval_ids: ['age_18_55'] },
      { type: 'signals', signal_refs: [{ scope: 'product', signal_id: 'age_selection' }] },
    ]) {
      for (const genderExecution of [{ type: 'gender_values' }, signalResolution.execution]) {
        const mixed = {
          requested: { age, gender }, applied: { age, gender }, equivalent: true,
          execution: { type: 'per_dimension', age: ageExecution, gender: genderExecution },
        };
        assert.equal(validateResolution(mixed), true, JSON.stringify(validateResolution.errors));
        const missing = structuredClone(mixed); delete missing.execution.gender;
        assert.equal(validateResolution(missing), false);
      }
    }
    assert.equal(validateResolution({ requested: { age, gender }, applied: { age, gender }, equivalent: true, execution: signalResolution.execution }), true,
      'joint signal compilation is validated semantically against complete predicates');
    for (const execution of [{ type: 'continuous_bounds' }, { type: 'enumerated_intervals', interval_ids: ['age_18_55'] }]) {
      assert.equal(validateResolution({ ...nativeResolution(), execution }), false, 'age execution cannot attest gender');
    }
    assert.equal(validateResolution({ ...nativeResolution(), applied: { age, gender } }), false, 'cannot introduce age');
    assert.equal(validateResolution({ ...nativeResolution(), applied: { age } }), false, 'cannot drop gender');
    assert.equal(validateResolution({ ...nativeResolution(), requested: { age, gender }, applied: { age, gender } }), false, 'native gender cannot attest mixed age');
    assert.equal(validateResolution({ ...nativeResolution(), equivalent: false }), false);
  });

  it('classifies each authoritative signal dimension independently across definitions and projections', () => {
    const fixtures = [
      [validateDefinition, { id: 'gender_selection', name: 'Gender selection', value_type: 'binary' }],
      [validateListing, { signal_ref: { scope: 'product', signal_id: 'gender_selection' }, name: 'Gender selection', value_type: 'binary' }],
      [validateEnrichment, {}],
    ];
    for (const [validate, base] of fixtures) {
      assert.equal(validate({ ...base, demographic_predicate: { gender }, restricted_attributes: ['sex_gender'] }), true, JSON.stringify(validate.errors));
      assert.equal(validate({ ...base, demographic_predicate: { gender }, restricted_attributes: ['age'] }), false);
      assert.equal(validate({ ...base, demographic_predicate: { gender } }), false);
      assert.equal(validate({ ...base, demographic_predicate: { age, gender }, restricted_attributes: ['age', 'sex_gender'] }), true);
      for (const restricted_attributes of [['age'], ['sex_gender']]) {
        assert.equal(validate({ ...base, demographic_predicate: { age, gender }, restricted_attributes }), false);
      }
      assert.equal(validate({ ...base, demographic_predicate: { age }, restricted_attributes: ['age'] }), true);
    }
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

  it('keeps basis constraints inside targeting age and excludes population estimates from execution', () => {
    assert.equal(validateIntent({
      age: {
        min: 25,
        max: 34,
        include_unknown: false,
        accepted_bases: ['verified', 'declared'],
        accepted_verification_methods: ['world_id', 'id_document'],
      },
    }), true, JSON.stringify(validateIntent.errors));

    assert.equal(validateIntent({
      age: {
        min: 25,
        max: 34,
        include_unknown: false,
        accepted_bases: ['population_estimate'],
      },
    }), false, 'aggregate evidence cannot be used for per-user execution');

    assert.equal(validateIntent({
      age: {
        min: 25,
        max: 34,
        include_unknown: false,
        accepted_bases: ['declared'],
        accepted_verification_methods: ['world_id'],
      },
    }), false, 'verification methods require verified to be an accepted basis');
  });

  it('lets legal verification narrow demographic bases but rejects an empty intersection', () => {
    assert.equal(validateTargeting({
      demographics: {
        age: { min: 21, include_unknown: false, accepted_bases: ['verified', 'declared'] },
      },
      age_restriction: { min: 21, verification_required: true, accepted_methods: ['world_id'] },
    }), true, JSON.stringify(validateTargeting.errors));

    assert.equal(validateTargeting({
      demographics: {
        age: { min: 21, include_unknown: false, accepted_bases: ['declared', 'inferred'] },
      },
      age_restriction: { min: 21, verification_required: true },
    }), false, 'verification_required wins over permissive demographic bases');
  });

  it('requires the execution detail promised by each product mode', () => {
    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        supports_unbounded_min: true,
        supports_unbounded_max: true,
        unknown_handling: 'selectable',
      },
    }), true);

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        supports_unbounded_min: true,
        supports_unbounded_max: true,
        unknown_handling: 'selectable',
        supported_bases: ['verified', 'declared'],
        supported_verification_methods: ['world_id'],
      },
    }), true, JSON.stringify(validateCapability.errors));

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        supports_unbounded_min: true,
        supports_unbounded_max: true,
        unknown_handling: 'selectable',
        supported_bases: ['declared'],
        supported_verification_methods: ['world_id'],
      },
    }), false, 'verification methods require verified product support');

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        supports_unbounded_min: true,
        supports_unbounded_max: true,
        unknown_handling: 'selectable',
        supported_bases: ['verified'],
      },
    }), false, 'verified product support must name its available methods');

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        unknown_handling: 'selectable',
      },
    }), false, 'continuous bounds require explicit support flags for both open directions');

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        unknown_handling: 'selectable',
      },
    }), false, 'continuous bounds require the supported domain and explicit open-bound flags');

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

  it('requires explicit support for each omitted continuous bound', () => {
    const capability = readSchema('/schemas/core/demographic-targeting-capability.json');
    const age = capability.properties.age.properties;

    assert.match(age.execution_modes.description, /supports_unbounded_min or supports_unbounded_max/);
    assert.match(age.min_supported_age.description, /omission means no lower age restriction/);
    assert.match(age.max_supported_age.description, /min 65 remains 65\+/);
    assert.match(age.supports_unbounded_min.description, /MUST reject open-lower predicates/);
    assert.match(age.supports_unbounded_max.description, /min 65 remains 65\+/);

    assert.equal(validateCapability({
      age: {
        execution_modes: ['continuous_bounds'],
        min_supported_age: 18,
        max_supported_age: 65,
        supports_unbounded_min: false,
        supports_unbounded_max: true,
        unknown_handling: 'selectable',
      },
    }), true, 'support for each open direction is declared independently');
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
      requested: {
        age: {
          min: 21,
          max: 35,
          include_unknown: false,
          accepted_bases: ['verified', 'declared'],
          accepted_verification_methods: ['world_id'],
        },
      },
      applied: requested,
      equivalent: true,
      execution: { type: 'continuous_bounds' },
      applied_bases: ['verified'],
      applied_verification_methods: ['world_id'],
    }), true, JSON.stringify(validateResolution.errors));
    assert.equal(validateResolution({
      requested: {
        age: { min: 21, max: 35, include_unknown: false, accepted_bases: ['declared'] },
      },
      applied: requested,
      equivalent: true,
      execution: { type: 'continuous_bounds' },
    }), false, 'basis-constrained intent requires applied basis readback');
    assert.equal(validateResolution({
      ...base,
      execution: { type: 'continuous_bounds' },
      applied_bases: ['declared'],
      applied_verification_methods: ['world_id'],
    }), false, 'verification methods cannot accompany a non-verified applied basis');
    assert.equal(validateResolution({
      ...base,
      execution: { type: 'continuous_bounds' },
      applied_bases: ['verified'],
    }), false, 'verified readback must name its effective methods');
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

  it('records the negative entailment vector for threshold-only verification', () => {
    const worldIdThresholdEntails = (predicate, threshold) => (
      predicate.min === threshold && predicate.max === undefined && predicate.include_unknown === false
    );

    assert.equal(worldIdThresholdEntails({ min: 21, include_unknown: false }, 21), true);
    assert.equal(worldIdThresholdEntails({ min: 25, max: 34, include_unknown: false }, 18), false);
    assert.equal(worldIdThresholdEntails({ min: 18, max: 34, include_unknown: false }, 18), false);
  });

  it('documents World ID compliance without a personhood-only or fail-open path', () => {
    const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'media-buy', 'advanced-topics', 'targeting.mdx'), 'utf8');

    assert.doesNotMatch(docs, /World ID orb verification/);
    assert.match(docs, /Orb\/personhood verification alone is insufficient/);
    assert.doesNotMatch(docs, /\{"min": 18, "accepted_methods": \["world_id"\]\}/);
    assert.match(docs, /\{"min": 18, "verification_required": true, "accepted_methods": \["world_id"\]\}/);
  });

  it('rejects every non-equivalent or self-approved stored resolution', () => {
    const nonExact = {
      requested: { age: { min: 21, max: 35, include_unknown: false } },
      applied: { age: { min: 25, max: 34, include_unknown: false } },
      equivalent: false,
      execution: { type: 'enumerated_intervals', interval_ids: ['age_25_34'] },
    };
    assert.equal(validateResolution(nonExact), false);
    assert.equal(validateResolution({ ...nonExact, difference_reason: 'Narrower alternative', buyer_approved: true }), false);
    assert.equal(validateResolution({
      ...nonExact,
      applied: nonExact.requested,
      equivalent: true,
      difference_reason: 'No difference',
    }), false, 'legacy alternative-approval fields are forbidden even on exact resolutions');
  });

  it('locks the request, product, capability-rollup, and package-readback schema paths', () => {
    const targeting = readSchema('/schemas/core/targeting.json');
    const product = readSchema('/schemas/core/product.json');
    const capabilities = readSchema('/schemas/protocol/get-adcp-capabilities-response.json');
    const packageSchema = readSchema('/schemas/core/package.json');
    const getMediaBuys = readSchema('/schemas/media-buy/get-media-buys-response.json');

    assert.equal(targeting.properties.demographics.$ref, '/schemas/core/demographic-targeting-intent.json');
    assert.equal(product.properties.demographic_targeting.$ref, '/schemas/core/demographic-targeting-capability.json');
    assert.equal(capabilities.properties.media_buy.properties.execution.properties.targeting.properties.demographics.properties.supported.type, 'boolean');
    assert.equal(packageSchema.properties.targeting_resolution.$ref, '/schemas/core/package-targeting-resolution.json');
    assert.equal(
      readSchema('/schemas/core/package-targeting-resolution.json').properties.demographics.$ref,
      '/schemas/core/demographic-targeting-resolution.json'
    );
    assert.equal(
      getMediaBuys.properties.media_buys.items.properties.packages.items.properties.targeting_resolution.$ref,
      '/schemas/core/package-targeting-resolution.json'
    );
  });
});
