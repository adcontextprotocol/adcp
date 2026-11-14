/**
 * audience_targeting without inline member push (#8936).
 *
 * supported_identifier_types and minimum_audience_size describe matching of
 * pushed members, so they are required only when the seller accepts inline
 * member push: supported_activation_methods is absent (the 3.2 meaning) or
 * includes the sync_audiences pattern. A seller that declares
 * supported_activation_methods without that pattern can declare
 * audience_targeting with neither field.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');
const CAPABILITIES_URI = '/schemas/protocol/get-adcp-capabilities-response.json';

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

function newAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async uri => readSchema(uri) });
  addFormats(ajv);
  return ajv;
}

const SYNC_AUDIENCES = { pattern: 'sync_audiences' };
const DATASET_QUERY = { pattern: 'dataset_query', vendor: { domain: 'data-cloud.example' } };
const PLATFORM_DISTRIBUTION = { pattern: 'platform_distribution', vendor: { domain: 'activation-hub.example' } };
const MATCHING = { supported_identifier_types: ['hashed_email'], minimum_audience_size: 100 };

function capabilities(audienceTargeting) {
  return {
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    ...(audienceTargeting.supported_activation_methods && {
      experimental_features: ['media_buy.audience_activation'],
    }),
    media_buy: { audience_targeting: audienceTargeting },
  };
}

describe('audience_targeting member-push requirements', () => {
  let validateAudienceTargeting;
  let validateCapabilities;

  before(async () => {
    const response = readSchema(CAPABILITIES_URI);
    const audienceTargeting = response.properties.media_buy.properties.audience_targeting;
    validateAudienceTargeting = await newAjv().compileAsync(audienceTargeting);
    validateCapabilities = await newAjv().compileAsync(response);
  });

  function accepts(value, message) {
    assert.equal(validateAudienceTargeting(value), true, `${message}: ${JSON.stringify(validateAudienceTargeting.errors)}`);
    assert.equal(validateCapabilities(capabilities(value)), true, `${message}: ${JSON.stringify(validateCapabilities.errors)}`);
  }

  function rejects(value, message) {
    assert.equal(validateAudienceTargeting(value), false, message);
    assert.equal(validateCapabilities(capabilities(value)), false, message);
    const missing = validateAudienceTargeting.errors
      .filter(error => error.keyword === 'required')
      .map(error => error.params.missingProperty);
    assert.ok(missing.length > 0, `${message}: expected a missing required field, got ${JSON.stringify(validateAudienceTargeting.errors)}`);
  }

  describe('positive vectors', () => {
    it('accepts the 3.2 shape: no supported_activation_methods, both matching fields', () => {
      accepts({ ...MATCHING, matching_latency_hours: { min: 1, max: 24 } }, '3.2 shape');
    });

    it('accepts inline push with both matching fields', () => {
      accepts({ ...MATCHING, supported_activation_methods: [SYNC_AUDIENCES, DATASET_QUERY] }, 'push declared');
    });

    it('accepts a seller without inline push that omits both matching fields', () => {
      accepts({ supported_activation_methods: [PLATFORM_DISTRIBUTION] }, 'no push, no matching fields');
      accepts({ supported_activation_methods: [DATASET_QUERY, PLATFORM_DISTRIBUTION] }, 'no push, two rails');
    });

    it('accepts a seller without inline push that still declares matching fields', () => {
      accepts({ ...MATCHING, supported_activation_methods: [DATASET_QUERY] }, 'no push, both fields');
      accepts({ minimum_audience_size: 1000, supported_activation_methods: [DATASET_QUERY] }, 'no push, size only');
    });
  });

  describe('negative vectors', () => {
    it('still requires both matching fields when supported_activation_methods is absent', () => {
      rejects({}, 'empty object keeps 3.2 required fields');
      rejects({ supported_identifier_types: ['hashed_email'] }, 'missing minimum_audience_size');
      rejects({ minimum_audience_size: 100 }, 'missing supported_identifier_types');
    });

    it('requires both matching fields when the sync_audiences pattern is declared', () => {
      rejects({ supported_activation_methods: [SYNC_AUDIENCES] }, 'push declared, no matching fields');
      rejects(
        { minimum_audience_size: 100, supported_activation_methods: [DATASET_QUERY, SYNC_AUDIENCES] },
        'push declared, missing supported_identifier_types'
      );
      rejects(
        { supported_identifier_types: ['hashed_phone'], supported_activation_methods: [SYNC_AUDIENCES] },
        'push declared, missing minimum_audience_size'
      );
    });

    it('keeps the field shapes when they are optional', () => {
      assert.equal(
        validateAudienceTargeting({ supported_identifier_types: [], supported_activation_methods: [DATASET_QUERY] }),
        false,
        'supported_identifier_types keeps minItems'
      );
      assert.equal(
        validateAudienceTargeting({ minimum_audience_size: 0, supported_activation_methods: [DATASET_QUERY] }),
        false,
        'minimum_audience_size keeps minimum'
      );
      assert.equal(
        validateAudienceTargeting({ supported_activation_methods: [] }),
        false,
        'an empty supported_activation_methods is not a no-push declaration'
      );
    });

    it('still requires the experimental feature id for supported_activation_methods', () => {
      const document = capabilities({ supported_activation_methods: [PLATFORM_DISTRIBUTION] });
      delete document.experimental_features;
      assert.equal(validateCapabilities(document), false);
    });
  });

  it('states the discovery and push rules in the schema descriptions', () => {
    const response = readSchema(CAPABILITIES_URI);
    const audienceTargeting = response.properties.media_buy.properties.audience_targeting;
    assert.match(audienceTargeting.description, /MUST answer discovery-only sync_audiences/);
    assert.match(audienceTargeting.description, /does not promise inline member push/);
    assert.match(audienceTargeting.description, /UNSUPPORTED_FEATURE/);
    assert.equal(audienceTargeting.required, undefined, 'matching fields are required only through if/then');
    assert.deepEqual(audienceTargeting.then.required, ['supported_identifier_types', 'minimum_audience_size']);

    const request = readSchema('/schemas/media-buy/sync-audiences-request.json');
    assert.match(request.properties.audiences.description, /UNSUPPORTED_FEATURE/);
    assert.match(request.description, /answers discovery-only calls/);
  });
});
