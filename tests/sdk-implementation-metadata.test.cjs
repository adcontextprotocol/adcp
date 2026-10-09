const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

async function loadSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

let validate;
before(async () => {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  validate = await ajv.compileAsync(await loadSchema('/schemas/protocol/get-adcp-capabilities-response.json'));
});

function capabilities(implementation) {
  return {
    status: 'completed',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.2', '3.3'],
      idempotency: { supported: false },
      ...(implementation === undefined ? {} : { implementation }),
    },
    supported_protocols: ['media_buy'],
  };
}

function sdk(overrides = {}) {
  return { name: '@adcp/sdk', version: '15.3.0', components: ['types'], ...overrides };
}

test('legacy responses remain valid and explicit no-SDK reports need no new capability flag', () => {
  assert.equal(validate(capabilities()), true, JSON.stringify(validate.errors));
  assert.equal(validate(capabilities({ sdks: [] })), true, JSON.stringify(validate.errors));
});

test('type-only, partial, and mixed SDK integrations validate without implying authentication', () => {
  for (const sdks of [
    [sdk()],
    [sdk({ components: ['types', 'schema_validation'] })],
    [sdk({ components: ['lifecycle', 'idempotency'] })],
    [sdk(), sdk({ name: 'adcp', version: '4.0.0rc1', components: ['authentication'] })],
  ]) {
    assert.equal(validate(capabilities({ sdks })), true, JSON.stringify(validate.errors));
  }
});

test('SDK metadata does not replace required AdCP capability declarations', () => {
  const response = capabilities({ sdks: [sdk()] });
  delete response.adcp.idempotency;
  assert.equal(validate(response), false);
  assert.ok(validate.errors.some(error => error.params.missingProperty === 'idempotency'));
});

test('package identities and versions support other SDKs, prereleases, and modified builds', () => {
  for (const [name, version] of [
    ['@adcp/sdk', '15.3.0-beta.1'],
    ['@adcp/sdk', '15.3.0+fork.1'],
    ['adcp', '4.0.0rc1'],
    ['github.com/adcontextprotocol/adcp-go', 'v1.2.0'],
    ['@example/adcp-sdk', '1.0.0'],
  ]) {
    assert.equal(validate(capabilities({ sdks: [sdk({ name, version })] })), true, JSON.stringify(validate.errors));
  }
});

test('SDK reports require package identity, version, and nonempty component coverage', () => {
  for (const field of ['name', 'version', 'components']) {
    const incomplete = sdk();
    delete incomplete[field];
    assert.equal(validate(capabilities({ sdks: [incomplete] })), false, `missing ${field}`);
  }
  for (const field of ['name', 'version']) {
    for (const value of ['', ' ', '15.3.0 latest', null, 15.3]) {
      assert.equal(validate(capabilities({ sdks: [sdk({ [field]: value })] })), false, `${field}: ${value}`);
    }
  }
  for (const components of [[], ['types', 'types'], ['full'], 'types', null]) {
    assert.equal(validate(capabilities({ sdks: [sdk({ components })] })), false, JSON.stringify(components));
  }
});

test('each defined server component can be declared independently', () => {
  for (const component of [
    'types', 'schema_validation', 'transport', 'authentication',
    'signing', 'lifecycle', 'idempotency', 'webhooks',
  ]) {
    assert.equal(validate(capabilities({ sdks: [sdk({ components: [component] })] })), true, component);
  }
});

test('malformed, duplicate, and approval-bearing reports are rejected', () => {
  for (const implementation of [
    null, true, [], {}, { sdks: null }, { sdks: {} }, { sdks: [null] },
    { sdks: [sdk(), sdk()] },
    { sdks: [], approved: true },
    { sdks: [sdk({ approved: true })] },
    { sdks: [sdk({ verified: true })] },
  ]) {
    assert.equal(validate(capabilities(implementation)), false, JSON.stringify(implementation));
  }
});
