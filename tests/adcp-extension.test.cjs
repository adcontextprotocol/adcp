'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { createAjvInstance, uriToLocalPath } = require('./json-schema-validation.test.cjs');
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

async function genderValidators() {
  const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true, loadSchema: async uri => {
    const match = /^https:\/\/adcontextprotocol\.org\/schemas\/(3\.2\.[12])\/(.+)$/.exec(uri);
    assert.ok(match, `Unexpected reference: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/schemas', match[1], match[2]), 'utf8'));
  } });
  addFormats(ajv);
  const namespace = await ajv.compileAsync(extension);
  const predicate = ajv.getSchema(`${extension.$id}#/definitions/gender_predicate`);
  const capability = ajv.getSchema(`${extension.$id}#/definitions/gender_capability`);
  const resolution = ajv.getSchema(`${extension.$id}#/definitions/gender_resolution`);
  const released = async filename => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/schemas/3.2.2', filename), 'utf8'));
    return ajv.getSchema(schema.$id) || ajv.compileAsync(schema);
  };
  return { namespace, predicate, capability, resolution, released, ajv };
}

test('gender vocabulary includes non-binary while unknown membership stays explicit', async () => {
  const { namespace, predicate } = await genderValidators();
  for (const values of [['female'], ['male'], ['non_binary'], ['female', 'non_binary'], ['female', 'male', 'non_binary']]) {
    for (const include_unknown of [false, true]) {
      assert.equal(predicate({ values, include_unknown }), true);
      assert.equal(namespace({ demographics: { gender: { values, include_unknown } } }), true);
    }
  }
  for (const invalid of [
    { values: ['non_binary'] },
    { include_unknown: false },
    { values: [], include_unknown: false },
    { values: ['female', 'female'], include_unknown: false },
    ...['other', 'unknown', 'O', '51', 'FEMALE'].map(value => ({ values: [value], include_unknown: false })),
    { values: ['non_binary'], include_unknown: 'false' },
    { values: ['non_binary'], include_unknown: false, include_unkown: true },
    null,
  ]) {
    assert.equal(predicate(invalid), false, JSON.stringify(invalid));
  }
  // The namespace admits a request-only clear; strict predicates/readback do not.
  assert.equal(namespace({ demographics: { gender: null }, unrelated_binding: { retained: true } }), true);
});

test('gender capabilities require an executable subset and explicit clear support', async () => {
  const { namespace, capability } = await genderValidators();
  const supported = { values: ['female', 'non_binary'], unknown_handling: 'selectable', supports_clearing: false };
  assert.equal(capability(supported), true);
  for (const unknown_handling of ['selectable', 'always_excluded', 'always_included']) {
    assert.equal(capability({ ...supported, unknown_handling, supports_clearing: true }), true);
  }
  for (const invalid of [
    { values: supported.values, unknown_handling: 'selectable' },
    { ...supported, values: [] },
    { ...supported, values: ['other'] },
    { ...supported, unknown_handling: 'all' },
    { ...supported, supports_clearing: 'yes' },
    { ...supported, execution_modes: ['signals'] },
  ]) assert.equal(capability(invalid), false, JSON.stringify(invalid));
  assert.equal(namespace({ demographic_targeting: { gender: supported } }), true);
  assert.equal(namespace({ bindings: ['demographics.gender.v1'] }), true);
  assert.equal(namespace({ bindings: ['demographics.gender.v1', 'demographics.gender.v1'] }), false);
});

test('gender execution attestation is native-only and uses strict predicates', async () => {
  const { namespace, resolution } = await genderValidators();
  const predicate = { values: ['female', 'non_binary'], include_unknown: false };
  const attestation = { requested: predicate, applied: predicate, equivalent: true, execution: { type: 'native' } };
  assert.equal(resolution(attestation), true);
  assert.equal(namespace({ demographic_targeting_resolution: { gender: attestation } }), true);
  for (const invalid of [
    { ...attestation, equivalent: false },
    { ...attestation, applied: null },
    { ...attestation, applied: { values: ['non_binary'] } },
    { ...attestation, execution: { type: 'signals' } },
    { ...attestation, execution: { type: 'native', signal_id: 'sig_1' } },
    { ...attestation, inferred: true },
  ]) assert.equal(resolution(invalid), false, JSON.stringify(invalid));
  // Equality and execution remain runtime obligations; JSON Schema cannot attest them.
});

test('gender-only discovery, mutation, and readback fit immutable 3.2.2 wire schemas', async () => {
  const { namespace, released, ajv } = await genderValidators();
  const gender = { values: ['non_binary'], include_unknown: false };
  const overlay = { ext: { adcp: { demographics: { gender } } } };
  const validateDiscovery = await released('media-buy/get-products-request.json');
  const request = { buying_mode: 'brief', brief: 'Video inventory.', targeting_overlay: overlay };
  assert.equal(validateDiscovery(request), true, JSON.stringify(validateDiscovery.errors));
  assert.equal(namespace(overlay.ext.adcp), true);
  const invalidOverlay = { ext: { adcp: { demographics: { gender: { values: ['other'], include_unknown: false } } } } };
  assert.equal(validateDiscovery({ ...request, targeting_overlay: invalidOverlay }), true);
  assert.equal(namespace(invalidOverlay.ext.adcp), false);

  const validateCompactDiscovery = await released('media-buy/list-products-request.json');
  assert.equal(validateCompactDiscovery({ criteria: { targeting_overlay: overlay }, fields: ['name'] }), true);
  assert.equal(validateCompactDiscovery({ criteria: { targeting_overlay: overlay }, fields: ['ext'] }), false);
  const validateProposalRequest = await released('media-buy/request-proposals-request.json');
  assert.equal(validateProposalRequest({ idempotency_key: 'proposal_gender_1', brand: { domain: 'acme.example' }, brief: 'Video inventory.', criteria: { targeting_overlay: overlay } }), true, JSON.stringify(validateProposalRequest.errors));
  const validateCanonicalProduct = await released('core/canonical-product.json');
  assert.equal(validateCanonicalProduct({ product_id: 'prod_1', name: 'Video inventory', ext: { adcp: { demographic_targeting: { gender: {
    values: ['non_binary'], unknown_handling: 'always_excluded', supports_clearing: true,
  } } } } }), true, JSON.stringify(validateCanonicalProduct.errors));

  const validateUpdate = await released('media-buy/package-update.json');
  assert.equal(validateUpdate({ package_id: 'pkg_1', targeting_overlay: overlay }), true);
  assert.equal(validateUpdate({ package_id: 'pkg_1', targeting_overlay: { ext: { adcp: { demographics: { gender: null } } } } }), true);
  const snapshot = {
    package_id: 'pkg_1', targeting_overlay: overlay,
    ext: { adcp: { demographic_targeting_resolution: { gender: {
      requested: gender, applied: gender, equivalent: true, execution: { type: 'native' },
    } } } },
  };
  const validateCreateResponse = await released('media-buy/create-media-buy-response.json');
  assert.equal(validateCreateResponse({ status: 'completed', media_buy_id: 'mb_1', confirmed_at: '2026-10-05T00:00:00Z', revision: 1, packages: [snapshot] }), true, JSON.stringify(validateCreateResponse.errors));
  const validateUpdateResponse = await released('media-buy/update-media-buy-response.json');
  assert.equal(validateUpdateResponse({ status: 'completed', media_buy_id: 'mb_1', revision: 2, affected_packages: [snapshot] }), true, JSON.stringify(validateUpdateResponse.errors));
  const validateReadback = await released('media-buy/get-media-buys-response.json');
  assert.equal(validateReadback({ status: 'completed', media_buys: [{ media_buy_id: 'mb_1', status: 'active', currency: 'USD', total_budget: 1000, confirmed_at: '2026-10-05T00:00:00Z', revision: 2, packages: [snapshot] }] }), true, JSON.stringify(validateReadback.errors));

  const validateCoreResolution = await released('core/package-targeting-resolution.json');
  assert.equal(validateCoreResolution({ ext: snapshot.ext }), false); // Core resolution requires age.
  const capabilitiesSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/schemas/3.2.2/protocol/get-adcp-capabilities-response.json'), 'utf8'));
  const validateNamespaces = ajv.compile(capabilitiesSchema.properties.extensions_supported);
  assert.equal(validateNamespaces(['adcp']), true);
  assert.equal(validateNamespaces(['demographics.gender.v1']), false);
});

test('documentation validation resolves immutable dependencies without falling back to source', async () => {
  const ajv = createAjvInstance();
  const validate = await ajv.compileAsync({ $ref: 'https://adcontextprotocol.org/schemas/3.2.1/core/opportunity-context.json' });
  assert.equal(validate({ opportunity_id: 'opp_1' }), true);
  assert.equal(validate({ opportunity_id: 'bad/id' }), false);
  await assert.rejects(ajv.compileAsync({ $ref: 'https://adcontextprotocol.org/schemas/99.99.99/core/opportunity-context.json' }), /Cannot resolve pinned release schema/);
  assert.throws(() => uriToLocalPath('/schemas/latest/../../../package.json'), /Invalid schema path/);
  await assert.rejects(ajv.opts.loadSchema('https://adcontextprotocol.org/schemas/3.2.1/../../../package.json'), /Invalid schema path/);
});
