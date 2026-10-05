'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const {
  validateExtensionNamespace,
  discoverExtensions,
  filterExtensionsForVersion,
  buildExtensions,
} = require('../scripts/build-schemas.cjs');

const sourceRoot = path.join(__dirname, '../static/schemas/source');
const extension = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'extensions/adcp.json'), 'utf8'));

test('reserved namespaces remain unavailable without the canonical owned entry', () => {
  for (const namespace of ['adcp', 'core', 'protocol', 'schema', 'meta', 'ext', 'context']) {
    assert.throws(() => validateExtensionNamespace(namespace), /reserved/);
    assert.throws(() => validateExtensionNamespace(namespace, { 'x-adcp-owned': true }), /reserved/);
  }
  assert.throws(() => validateExtensionNamespace('adcp', { ...extension, 'x-adcp-owned': false }), /reserved/);
  assert.throws(() => validateExtensionNamespace('adcp', { ...extension, $id: '/schemas/extensions/vendor.json' }), /reserved/);
  assert.throws(() => validateExtensionNamespace('core', extension), /reserved/);
  assert.doesNotThrow(() => validateExtensionNamespace('adcp', extension));
  assert.doesNotThrow(() => validateExtensionNamespace('example_vendor'));
});

test('registry discovery and publication include the owned binding only from 3.2 onward', () => {
  const entries = discoverExtensions(path.join(sourceRoot, 'extensions'));
  assert.ok(entries.some(entry => entry.namespace === 'adcp'));
  assert.equal(filterExtensionsForVersion(entries, '3.1.99').some(entry => entry.namespace === 'adcp'), false);
  assert.equal(filterExtensionsForVersion(entries, '3.2.1').some(entry => entry.namespace === 'adcp'), true);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-extension-'));
  try {
    const result = buildExtensions(sourceRoot, target, '3.3.0-beta.1');
    assert.ok(result.extensions.includes('adcp'));
    const registry = JSON.parse(fs.readFileSync(path.join(target, 'extensions/index.json'), 'utf8'));
    assert.equal(registry.extensions.adcp.$ref, 'https://adcontextprotocol.org/schemas/3.3.0-beta.1/extensions/adcp.json');
    const built = JSON.parse(fs.readFileSync(path.join(target, 'extensions/adcp.json'), 'utf8'));
    assert.equal(built.properties.opportunity.$ref, 'https://adcontextprotocol.org/schemas/3.2.1/core/opportunity-context.json');
    assert.equal(built.$id, registry.extensions.adcp.$ref);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('typed namespace validates the published opportunity shape and remains opt-in', async () => {
  const prefix = 'https://adcontextprotocol.org/schemas/3.2.1/';
  const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true, loadSchema: async uri => {
    assert.ok(uri.startsWith(prefix), `Unexpected reference: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/schemas/3.2.1', uri.slice(prefix.length)), 'utf8'));
  } });
  addFormats(ajv);
  const validate = await ajv.compileAsync(extension);
  assert.equal(validate({}), true);
  assert.equal(validate({ opportunity: { opportunity_id: 'opp_spring_launch' } }), true);
  assert.equal(validate({ opportunity: { opportunity_id: 'a'.repeat(255) } }), true);
  for (const opportunity_id of ['', 'a'.repeat(256), 'bad id', 'bad/id', 'bad\nid', 123]) {
    assert.equal(validate({ opportunity: { opportunity_id } }), false);
  }
  assert.equal(validate({ opportunity: { opportunity_id: 'opp_1', status: 'closed' } }), false);
  assert.equal(validate({ opportunity: { opportunity_id: 'opp_1', status: 'closed', close_reason: 'other' } }), false);
  assert.equal(validate({ opportunity: { opportunity_id: 'opp_1', status: 'closed', close_reason: 'other', close_detail: 'Plans changed' } }), true);
  const validateRequest = await ajv.compileAsync(JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/schemas/3.2.1/media-buy/get-products-request.json'), 'utf8')));
  const request = { buying_mode: 'brief', brief: 'Video inventory for a spring launch.', account: { account_id: 'acc_spring_launch' } };
  assert.equal(validateRequest(request), true);
  assert.equal(validateRequest({ ...request, ext: { adcp: { opportunity: { opportunity_id: 'opp_spring_launch' } } } }), true);
});
