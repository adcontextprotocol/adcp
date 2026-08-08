const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const fixture = JSON.parse(readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/trusted-match-context-merge/vectors.json'),
  'utf8',
));

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function referenceMerge(providerResponses) {
  const output = {
    status: 'completed',
    type: 'context_match_response',
    request_id: providerResponses[0].response.request_id,
    offers: [],
  };
  const segments = [];
  const signalsByProvider = new Map();

  for (const { registration_provider_id: providerId, response } of providerResponses) {
    output.offers.push(...response.offers);
    segments.push(...(response.signals?.segments || []));

    const targetingKvs = response.signals?.targeting_kvs;
    if (targetingKvs?.length) {
      signalsByProvider.set(providerId, { targeting_kvs: structuredClone(targetingKvs) });
    }
    // A provider-supplied signals_by_provider map is deliberately not read.
  }

  if (segments.length) output.signals = { segments };
  if (signalsByProvider.size) output.signals_by_provider = Object.fromEntries(signalsByProvider);
  return output;
}

function applyPublisherMapping(response, mapping) {
  const targeting = [];
  for (const [providerId, bucket] of Object.entries(response.signals_by_provider || {})) {
    if (!Object.hasOwn(mapping, providerId)) continue;
    const providerMapping = mapping[providerId];
    if (providerMapping === null || typeof providerMapping !== 'object') continue;
    for (const pair of bucket.targeting_kvs) {
      if (!Object.hasOwn(providerMapping, pair.key)) continue;
      const localKey = providerMapping[pair.key];
      if (localKey) targeting.push({ key: localKey, value: pair.value });
    }
  }
  return targeting;
}

function sortTargeting(targeting) {
  return [...targeting].sort((a, b) =>
    a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
}

describe('Trusted Match Context targeting merge vectors', () => {
  let validateProviderResponse;
  let validateRouterResponse;
  let validatePublisherConfig;

  before(async () => {
    [validateProviderResponse, validateRouterResponse, validatePublisherConfig] = await Promise.all([
      compile('/schemas/trusted-match/provider-context-match-response.json'),
      compile('/schemas/trusted-match/context-match-response.json'),
      compile('/schemas/trusted-match/publisher-targeting-kv-config.json'),
    ]);
  });

  it('publishes schema-valid provider-hop responses', () => {
    const legitimateResponses = fixture.provider_responses.filter(
      ({ response }) => !Object.hasOwn(response, 'signals_by_provider'),
    );
    assert.ok(legitimateResponses.length > 0);
    for (const { registration_provider_id: providerId, response } of legitimateResponses) {
      assert.equal(
        validateProviderResponse(response),
        true,
        `${providerId}: ${JSON.stringify(validateProviderResponse.errors)}`,
      );
    }
  });

  it('rejects provider-authored attribution buckets on the provider hop', () => {
    const spoof = fixture.provider_responses.find(
      ({ response }) => Object.hasOwn(response, 'signals_by_provider'),
    );
    assert.ok(spoof, 'fixture must include a provider-supplied attribution bucket');
    assert.equal(validateProviderResponse(spoof.response), false);
  });

  it('derives provider buckets from registration and preserves targeting pairs unchanged', () => {
    const actual = referenceMerge(fixture.provider_responses);
    assert.deepEqual(actual, fixture.expected_router_response);
    assert.equal(validateRouterResponse(actual), true, JSON.stringify(validateRouterResponse.errors));
    assert.equal(actual.signals?.targeting_kvs, undefined);
    assert.equal(actual.signals_by_provider.provider_a.targeting_kvs[0].value, 'alpha');
  });

  it('omits providers with absent or empty targeting pairs and safely retains legal object-like IDs', () => {
    const actual = referenceMerge(fixture.provider_responses);
    assert.equal(actual.signals_by_provider.provider_absent, undefined);
    assert.equal(actual.signals_by_provider.provider_empty, undefined);
    assert.equal(Object.hasOwn(actual.signals_by_provider, '__proto__'), true);
    assert.deepEqual(actual.signals_by_provider.__proto__.targeting_kvs, [
      { key: 'edge_key', value: 'proto-value' },
    ]);
  });

  it('does not trust a provider-supplied attribution bucket', () => {
    const actual = referenceMerge(fixture.provider_responses);
    assert.equal(actual.signals_by_provider.provider_spoof, undefined);
    assert.notEqual(actual.signals_by_provider.provider_a.targeting_kvs[0].value, 'spoofed');
  });

  it('maps by provider and drops unmapped tuples at the publisher boundary', () => {
    assert.equal(
      validatePublisherConfig(fixture.publisher_config),
      true,
      JSON.stringify(validatePublisherConfig.errors),
    );
    const actual = applyPublisherMapping(
      fixture.expected_router_response,
      fixture.publisher_config.targeting_kv_mapping,
    );
    assert.deepEqual(sortTargeting(actual), sortTargeting(fixture.expected_publisher_targeting));
    assert.equal(
      actual.some(({ value }) => value.includes('constructor-value') || value.includes('case-sensitive-drop')),
      false,
      'inherited or case-normalized provider/key lookups must not create publisher targeting',
    );
    assert.deepEqual(
      actual.filter(({ key }) => key === 'gam_shared').map(({ value }) => value).sort(),
      ['alpha', 'alpha', 'bravo'],
      'destination aliases and exact duplicates must retain every value instead of overwriting',
    );
  });

  it('does not resolve inherited provider or key mappings', () => {
    const inheritedOuter = Object.create({
      provider_a: { shared_key: 'inherited_outer_destination' },
    });
    assert.deepEqual(applyPublisherMapping(fixture.expected_router_response, inheritedOuter), []);

    const inheritedInner = Object.create({ shared_key: 'inherited_inner_destination' });
    const ownOuter = Object.create(null);
    ownOuter.provider_a = inheritedInner;
    assert.deepEqual(applyPublisherMapping(fixture.expected_router_response, ownOuter), []);
  });

  it('rejects invalid publisher targeting mappings', () => {
    const invalidConfigs = [
      { targeting_kv_mapping: { 'bad-provider': { key: 'destination' } } },
      { targeting_kv_mapping: { provider_a: {} } },
      { targeting_kv_mapping: { provider_a: { key: '' } } },
      {},
      { targeting_kv_mapping: {}, unexpected: true },
    ];
    for (const config of invalidConfigs) {
      assert.equal(validatePublisherConfig(config), false, `${JSON.stringify(config)} unexpectedly validated`);
    }
  });

  it('rejects invalid merged response shapes', () => {
    for (const vector of fixture.invalid_router_responses) {
      assert.equal(validateRouterResponse(vector.response), false, `${vector.id} unexpectedly validated`);
    }
  });
});
