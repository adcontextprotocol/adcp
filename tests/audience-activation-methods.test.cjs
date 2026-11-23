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

// Follows a $ref (a local #/definitions pointer or a /schemas/ document) to the schema it names.
function deref(node, doc) {
  while (node && typeof node.$ref === 'string') {
    if (node.$ref.startsWith('#/')) {
      node = node.$ref.slice(2).split('/').reduce((n, key) => n[key], doc);
    } else {
      doc = readSchema(node.$ref);
      node = doc;
    }
  }
  return node;
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

describe('audience activation method declarations', () => {
  let validate;

  before(async () => {
    validate = await compile('/schemas/core/audience-activation-method.json');
  });

  it('accepts both global and deployment-scoped dataset principals', () => {
    assert.equal(validate({
      pattern: 'dataset_query',
      vendor: { domain: 'data-cloud.example' },
      consumer_identities: [
        { identity: 'serviceAccount:adcp-ingest@publisher.example' },
        { cloud: 'aws', region: 'us-east-1', identity: 'SELLERORG.ADCP_INGEST' },
      ],
    }), true, JSON.stringify(validate.errors));
  });

  it('requires cloud and region deployment metadata to appear together', () => {
    const base = {
      pattern: 'dataset_query',
      vendor: { domain: 'data-cloud.example' },
    };

    assert.equal(validate({
      ...base,
      consumer_identities: [{ cloud: 'aws', identity: 'SELLERORG.ADCP_INGEST' }],
    }), false);

    assert.equal(validate({
      ...base,
      consumer_identities: [{ region: 'us-east-1', identity: 'SELLERORG.ADCP_INGEST' }],
    }), false);

    assert.equal(validate({
      ...base,
      consumer_identities: [{ identity: '' }],
    }), false);
  });

  it('allows platform support before an account-scoped destination is configured', () => {
    assert.equal(validate({
      pattern: 'platform_distribution',
      vendor: { domain: 'activation-hub.example' },
    }), true, JSON.stringify(validate.errors));

    assert.equal(validate({
      pattern: 'platform_distribution',
      vendor: { domain: 'activation-hub.example' },
      destination_ref: 'seat_12345',
      bind_expiry_days: 14,
    }), true, JSON.stringify(validate.errors));

    assert.equal(validate({
      pattern: 'platform_distribution',
      vendor: { domain: 'activation-hub.example' },
      destination_ref: '',
    }), false);
  });

  it('defines clean-room activation as targetable rather than analytics-only', () => {
    const schema = readSchema('/schemas/core/audience-activation-method.json');
    // The branch states its description at the call site, beside the $ref.
    const site = schema.oneOf.find(branch => deref(branch, schema).properties.pattern.const === 'clean_room');
    const cleanRoom = { ...deref(site, schema), description: site.description };

    assert.match(cleanRoom.description, /MUST declare.*targetable on this product/);
    assert.match(cleanRoom.description, /analytics-only or measurement-only.*does not qualify/);
    assert.equal(validate({
      pattern: 'clean_room',
      vendor: { domain: 'collaboration-room.example' },
    }), true, JSON.stringify(validate.errors));
  });
});
