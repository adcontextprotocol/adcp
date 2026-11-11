const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.join(__dirname, '../static/schemas/source');
const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true });
addFormats(ajv);
ajv.addFormat('uri-template', true);
for (const file of fs.readdirSync(root, { recursive: true })) {
  if (!file.endsWith('.json')) continue;
  const schema = JSON.parse(fs.readFileSync(path.join(root, file)));
  if (schema.$id) ajv.addSchema(schema);
}
const clone = structuredClone;
function validate(name, value, expected = true) {
  const validator = ajv.getSchema(`/schemas/${name}.json`);
  assert.ok(validator, `missing ${name} contract`);
  assert.equal(validator(value), expected, JSON.stringify(validator.errors));
}
const hash = `sha256:${'a'.repeat(64)}`;
const registration = {
  agent_name: 'sentinel', mode: 'required', max_hold_seconds: 60,
  agent_url: 'https://addons.example/agent',
};
const disclosure = {
  scope: 'product', product_id: 'display', complete: true,
  signed_chain_profile: 'adcp/addon-chain/v1',
  vendors: [{ agent_name: 'sentinel', source: 'live', agent_url: 'https://addons.example/agent',
    mode: 'required', max_hold_seconds: 60, format_kinds: ['image'], positions: ['prepend'] }],
};
const request = {
  idempotency_key: 'addon-operation-0001', operator_name: 'Example Sales',
  operator_url: 'https://sales.example/agent', publisher_domain: 'publisher.example',
  creatives: [{ creative_id: 'creative-1', format_kind: 'image', dimensions: { w: 300, h: 250 } }],
};
const fragment = { creative_id: 'creative-1', position: 'prepend', content: '<script></script>', content_hash: hash };
const chain = {
  creative_id: 'creative-1', creative_hash: hash, configuration: disclosure,
  entries: [{ order: 0, registration_index: 0, fragment_index: 0, agent_name: 'sentinel',
    agent_url: 'https://addons.example/agent', source: 'live', status: 'applied', position: 'prepend',
    content_hash: hash, bytes: 17, timestamp: '2026-10-14T12:00:00Z' }],
  chain_hash: hash,
  signed_attestation: { profile: 'adcp/addon-chain/v1', protected: 'e30', payload: 'e30', signature: 'a'.repeat(86) },
};

test('fragment request batches context without admitting creative payloads or unsupported formats', () => {
  validate('creative/get-creative-addons-request', request);
  for (const format_kind of ['html5', 'display_tag']) {
    validate('creative/get-creative-addons-request', { ...request, creatives: [{ creative_id: 'c', format_kind }] });
  }
  for (const mutation of [
    r => { r.creatives[0].format_kind = 'video_vast'; },
    r => { r.creatives[0].creative_manifest = { assets: [] }; },
    r => { r.creatives[0].content = '<html>buyer content</html>'; },
    r => { r.creatives = []; },
    r => { delete r.idempotency_key; },
    r => { r.creatives[0].dimensions.w = 0; },
  ]) { const r = clone(request); mutation(r); validate('creative/get-creative-addons-request', r, false); }
});

test('response separates successful omissions from terminal errors and rejects invalid fragments', () => {
  validate('creative/get-creative-addons-response', { status: 'completed', addons: [fragment] });
  validate('creative/get-creative-addons-response', { status: 'completed', addons: [] });
  validate('creative/get-creative-addons-response', { status: 'failed', errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' }] });
  validate('creative/get-creative-addons-response', { addons: [], errors: [{ code: 'SERVICE_UNAVAILABLE' }] }, false);
  validate('creative/get-creative-addons-response', { errors: [] }, false);
  for (const change of [{ position: 'inside' }, { content_hash: 'sha256:wrong' }, { content: '' }]) {
    validate('core/creative-addon-fragment', { ...fragment, ...change }, false);
  }
});

test('registration requires one source and a finite positive hold for seller-required vendors', () => {
  validate('core/creative-addon-registration', registration);
  const staticVendor = { agent_name: 'meter', mode: 'best_effort', static_reference: {
    format_kinds: ['image'], position: 'append', content: '<script></script>' } };
  validate('core/creative-addon-registration', staticVendor);
  validate('core/creative-addon-registration', { ...staticVendor, agent_url: registration.agent_url }, false);
  const noHold = clone(registration); delete noHold.max_hold_seconds;
  validate('core/creative-addon-registration', noHold, false);
  for (const value of [0, -1, 0.1]) validate('core/creative-addon-registration', { ...registration, max_hold_seconds: value }, false);
});

test('disclosure separates undeclared, complete-empty and scoped resolved configuration without exposing loader code', () => {
  validate('core/creative-addon-disclosure', disclosure);
  validate('core/creative-addon-disclosure', { ...disclosure, vendors: [] });
  const bad = clone(disclosure); delete bad.product_id;
  validate('core/creative-addon-disclosure', bad, false);
  validate('core/creative-addon-disclosure', { ...disclosure, vendors: [{ ...disclosure.vendors[0], content: 'secret' }] }, false);
  validate('core/canonical-product', { product_id: 'display', name: 'Display', creative_addons: disclosure });
  validate('media-buy/product-purchase', { product_id: 'display', pricing_option_id: 'cpm', creative_addons: disclosure });
  validate('media-buy/product-purchase', { product_id: 'display', pricing_option_id: 'cpm', creative_addons: { ...disclosure, complete: false } }, false);
  validate('media-buy/product-purchase-input', { product_id: 'display', pricing_option_id: 'cpm' });
  validate('media-buy/product-purchase-input', { product_id: 'display', pricing_option_id: 'cpm', creative_addons: disclosure }, false);
});

test('buyer-facing chains require signatures and distinguish omission reasons without fragment disclosure', () => {
  validate('core/creative-addon-chain', chain);
  validate('core/creative-variant', { variant_id: 'variant-1', addon_chain: chain });
  const unsigned = clone(chain); delete unsigned.signed_attestation;
  validate('core/creative-addon-chain', unsigned, false);
  for (const key of ['content', 'auth']) {
    const bad = clone(chain); bad.entries[0][key] = 'secret';
    validate('core/creative-addon-chain', bad, false);
  }
  const omitted = clone(chain);
  omitted.entries = [{ order: 0, registration_index: 0, agent_name: 'sentinel', source: 'live',
    agent_url: registration.agent_url, status: 'omitted', reason: 'vendor_omission', timestamp: '2026-10-14T12:00:00Z' }];
  validate('core/creative-addon-chain', omitted);
  omitted.entries[0].reason = 'failure';
  validate('core/creative-addon-chain', omitted, false);
  omitted.entries[0].error_code = 'ADDON_UNREACHABLE';
  validate('core/creative-addon-chain', omitted);
});

test('signing keys enforce dedicated public Ed25519 material and reject private keys', () => {
  const key = { kid: 'addon-1', kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
    key_ops: ['verify'], adcp_use: 'addon-chain-signing', x: 'a'.repeat(43) };
  validate('core/creative-addon-signing-key', key);
  for (const change of [{ adcp_use: 'request-signing' }, { alg: 'none' }, { key_ops: ['sign'] }, { d: 'secret' }]) {
    validate('core/creative-addon-signing-key', { ...key, ...change }, false);
  }
});

test('addon capability cannot opt out of signed chains or claim unsupported formats', () => {
  const capability = { supported_format_kinds: ['image'], positions: ['prepend'],
    signed_chain: { required: true, profile: 'adcp/addon-chain/v1' } };
  validate('core/creative-addon-capability', capability);
  validate('core/creative-addon-capability', { ...capability, signed_chain: { ...capability.signed_chain, required: false } }, false);
  validate('core/creative-addon-capability', { ...capability, supported_format_kinds: ['video_vast'] }, false);
  validate('enums/specialism', 'creative-addon');
});

test('addon task is discoverable in the creative protocol and terminal status matches its domain outcome', () => {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json')));
  assert.ok(index.schemas.creative.tasks['get-creative-addons'], 'task belongs to creative protocol');
  validate('creative/get-creative-addons-response', { status: 'failed', addons: [] }, false);
  validate('creative/get-creative-addons-response', { status: 'completed', errors: [{ code: 'SERVICE_UNAVAILABLE' }] }, false);
  validate('creative/get-creative-addons-response', { status: 'completed', addons: [], errors: [{ code: 'SERVICE_UNAVAILABLE' }] }, false);
});

test('published positive vectors validate their wire shapes and decoded signed claims', () => {
  const fixtures = path.join(__dirname, '../static/compliance/source/test-vectors');
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'creative-addon-chain.json')));
  const vectorSchema = JSON.parse(fs.readFileSync(path.join(fixtures, 'creative-addon-chain.schema.json')));
  const validator = ajv.compile(vectorSchema);
  assert.equal(validator(fixture), true, JSON.stringify(validator.errors));
  const claims = ajv.getSchema('/schemas/core/creative-addon-chain.json#/definitions/Claims');
  const header = ajv.getSchema('/schemas/core/creative-addon-chain.json#/definitions/ProtectedHeader');
  for (const vector of fixture.valid) {
    assert.equal(claims(JSON.parse(Buffer.from(vector.chain.signed_attestation.payload, 'base64url'))), true, JSON.stringify(claims.errors));
    assert.equal(header(JSON.parse(Buffer.from(vector.chain.signed_attestation.protected, 'base64url'))), true, JSON.stringify(header.errors));
  }
});

test('product and account disclosures cannot cross scopes or report failed resolution as complete', () => {
  const accountDisclosure = { ...disclosure, scope: 'account' }; delete accountDisclosure.product_id;
  validate('core/canonical-product', { product_id: 'display', name: 'Display', creative_addons: accountDisclosure }, false);
  const account = { account: { account_id: 'account-1' }, action: 'unchanged', status: 'active', creative_addons: accountDisclosure };
  validate('account/sync-accounts-response', { status: 'completed', accounts: [account] });
  validate('account/sync-accounts-response', { status: 'completed', accounts: [{ ...account, creative_addons: disclosure }] }, false);
  validate('account/sync-accounts-response', { status: 'completed', accounts: [{ ...account, action: 'failed', errors: [{ code: 'PERMISSION_DENIED' }] }] }, false);
});

test('canonical product projections can request the addon compatibility disclosure', () => {
  validate('media-buy/product-fields', ['product_id', 'creative_addons']);
});
