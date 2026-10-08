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
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const AGENT = { type: 'agent', agent_url: 'https://seller.example-agent.com', is_live: false };

describe('signal delivery methods (experimental)', () => {
  let method;
  let deployment;
  let destination;
  let capabilities;

  before(async () => {
    method = await compile('/schemas/core/signal-delivery-method.json');
    deployment = await compile('/schemas/core/deployment.json');
    destination = await compile('/schemas/core/destination.json');
    capabilities = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  });

  it('accepts every send-side pattern', () => {
    for (const entry of readSchema('/schemas/core/signal-delivery-method.json').examples) {
      assert.equal(method(entry), true, JSON.stringify([entry, method.errors]));
    }
  });

  it('rejects tmp_identity_match and vendor-less vendor patterns', () => {
    assert.equal(method({ pattern: 'tmp_identity_match', buyer_agent: { agent_url: 'https://b.example-agent.com' } }), false);
    assert.equal(method({ pattern: 'dataset_query' }), false);
    assert.equal(method({ pattern: 'file_transfer', vendor: { domain: 'object-store.example' } }), false);
    assert.equal(method({ pattern: 'platform_distribution', vendor: { domain: 'a.example' }, destination_ref: 'x' }), false);
  });

  it('keeps patterns in step with audience-activation-method minus tmp_identity_match', () => {
    const receive = readSchema('/schemas/core/audience-activation-method.json').oneOf
      .map(v => v.properties.pattern.const).filter(p => p !== 'tmp_identity_match').sort();
    const send = readSchema('/schemas/core/signal-delivery-method.json').oneOf.map(v => v.properties.pattern.const).sort();
    assert.deepEqual(send, receive);
    const pin = readSchema('/schemas/core/destination.json').oneOf[1].properties.delivery_method.properties.pattern.enum;
    assert.deepEqual([...pin].sort(), receive);
  });

  it('keeps match_status in step with the audience-status enum', () => {
    const inline = readSchema('/schemas/core/deployment.json').oneOf[1].properties.match_status.enum;
    assert.deepEqual(inline, readSchema('/schemas/enums/audience-status.json').enum);
  });

  it('keeps the delivery descriptor in step with audience-source', () => {
    const source = readSchema('/schemas/core/audience-source.json').oneOf;
    const delivery = readSchema('/schemas/core/deployment.json').oneOf[1].properties.delivery;
    assert.deepEqual(delivery.properties.kind.enum, source.map(v => v.properties.kind.const));
    const dataset = source.find(v => v.properties.kind.const === 'dataset').properties;
    const segment = source.find(v => v.properties.kind.const === 'platform_segment').properties;
    for (const key of ['minLength', 'maxLength']) {
      assert.equal(delivery.properties.locator[key], dataset.locator[key]);
      assert.equal(delivery.properties.segment_ref[key], segment.segment_ref[key]);
    }
    assert.equal(delivery.properties.vendor.$ref, dataset.vendor.$ref);
  });

  it('accepts a destination pin and rejects tmp_identity_match as a pin', () => {
    const base = { type: 'agent', agent_url: 'https://seller.example-agent.com' };
    assert.equal(destination({ ...base, delivery_method: { pattern: 'clean_room' } }), true);
    assert.equal(destination({ ...base, delivery_method: { pattern: 'platform_distribution', vendor: { domain: 'a.example' } } }), true);
    assert.equal(destination({ ...base, delivery_method: { pattern: 'tmp_identity_match' } }), false);
  });

  it('accepts arrival, delivery descriptor, and match outcome on agent deployments', () => {
    assert.equal(deployment({
      ...AGENT,
      is_live: true,
      delivery_state: 'delivered',
      delivery: { kind: 'platform_segment', vendor: { domain: 'activation-hub.example' }, segment_ref: 'seg_88213' },
      match_status: 'ready',
      matched_count: 1200,
      effective_match_rate: 0.58,
    }), true, JSON.stringify(deployment.errors));
    assert.equal(deployment({
      ...AGENT,
      delivery_state: 'failed',
      delivery_error: { code: 'UNSUPPORTED_FEATURE', message: 'No shared rail.', field: 'destinations[0]' },
    }), true, JSON.stringify(deployment.errors));
  });

  it('rejects malformed delivery descriptors and unknown arrival states', () => {
    assert.equal(deployment({ ...AGENT, delivery: { kind: 'dataset', vendor: { domain: 'a.example' } } }), false);
    assert.equal(deployment({ ...AGENT, delivery: { kind: 'dataset', vendor: { domain: 'a.example' }, segment_ref: 's' } }), false);
    assert.equal(deployment({ ...AGENT, delivery_state: 'pending' }), false);
    assert.equal(deployment({ ...AGENT, effective_match_rate: 2 }), false);
  });

  it('requires the experimental feature flag when delivery_methods is declared', () => {
    const caps = {
      status: 'completed',
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['signals'],
      signals: { delivery_methods: [{ pattern: 'sync_audiences' }] },
    };
    assert.equal(capabilities(caps), false);
    assert.equal(capabilities({ ...caps, experimental_features: ['signals.delivery_methods'] }), true, JSON.stringify(capabilities.errors));
  });
});
