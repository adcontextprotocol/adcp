const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');

async function loadSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

const householdKey = {
  uid_type: 'maid',
  vendor: { domain: 'example-graph.com' },
  scopes: ['devices', 'households'],
  uses: ['audience_exclude', 'frequency_cap', 'identity_match'],
};

test('match keys accept multiple scopes and require a vendor for other', async () => {
  const validate = await compile('/schemas/core/match-key.json');
  assert.equal(validate(householdKey), true, JSON.stringify(validate.errors));
  assert.equal(validate({ uid_type: 'id5', scopes: ['individuals'], uses: ['audience_include'] }), true);
  assert.equal(validate({ uid_type: 'other', scopes: ['households'], uses: ['audience_include'] }), false, 'other needs vendor');
  assert.equal(
    validate({ uid_type: 'other', vendor: { domain: 'example-graph.com' }, scopes: ['households'], uses: ['audience_include'] }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(validate({ ...householdKey, scopes: [] }), false, 'scopes is non-empty');
  assert.equal(validate({ ...householdKey, scopes: ['custom'] }), false, 'custom is not comparable across parties');
  assert.equal(validate({ ...householdKey, uses: ['retargeting'] }), false, 'retargeting is audience_include');
  assert.equal(validate({ ...householdKey, match_rate: 0.4 }), false, 'capability only, no match rates');
});

test('scopes that come from a graph name the graph', async () => {
  const validate = await compile('/schemas/core/match-key.json');
  const { vendor, ...noVendor } = householdKey;
  assert.equal(validate(noVendor), false, 'households needs vendor');
  for (const uid_type of ['rampid', 'id5', 'uid2']) {
    assert.equal(validate({ ...noVendor, uid_type }), false, `${uid_type} at households needs vendor`);
    assert.equal(validate({ ...noVendor, uid_type, scopes: ['individuals'] }), true, `${uid_type} at individuals is native`);
  }
  for (const uid_type of ['maid', 'publisher_first_party']) {
    assert.equal(validate({ ...noVendor, uid_type, scopes: ['individuals'] }), false, `${uid_type} at individuals needs vendor`);
    assert.equal(validate({ ...noVendor, uid_type, scopes: ['individuals'], vendor }), true, uid_type);
  }
  assert.equal(validate({ ...noVendor, scopes: ['devices'] }), true, 'maid at devices is native');
  assert.equal(validate({ ...noVendor, uid_type: 'publisher_first_party', scopes: ['cookies', 'accounts'] }), true);
});

test('PAIR and hashed_email are never forwarded to Identity Match', async () => {
  const validate = await compile('/schemas/core/match-key.json');
  for (const uid_type of ['pairid', 'hashed_email']) {
    assert.equal(validate({ uid_type, scopes: ['individuals'], uses: ['audience_include', 'audience_exclude'] }), true, uid_type);
    assert.equal(validate({ uid_type, scopes: ['individuals'], uses: ['identity_match'] }), false, uid_type);
  }
});

test('product-level keys inherit surface and respect identity absence', async () => {
  const validate = await compile('/schemas/core/product-identity.json');
  assert.equal(validate({ persistent_identifier: true, match_keys: [householdKey] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ match_keys: [householdKey] }), false, 'persistent_identifier stays required');
  assert.equal(
    validate({ persistent_identifier: true, match_keys: [{ ...householdKey, property_types: ['website'] }] }),
    false,
    'property_types is seller-wide only'
  );
  for (const use of ['frequency_cap', 'identity_match']) {
    assert.equal(
      validate({ persistent_identifier: false, match_keys: [{ ...householdKey, uses: [use] }] }),
      false,
      `${use} needs a persistent identifier`
    );
  }
  assert.equal(
    validate({ persistent_identifier: false, match_keys: [{ ...householdKey, uses: ['audience_exclude'] }] }),
    true,
    JSON.stringify(validate.errors)
  );
});

test('an identity_match key requires a product that supports Identity Match', async () => {
  const storyboard = YAML.parse(
    fs.readFileSync(path.join(ROOT, 'static/compliance/source/specialisms/sales-dooh/index.yaml'), 'utf8')
  );
  const fixture = storyboard.fixtures.products[0];
  const product = {
    ...fixture,
    pricing_options: storyboard.fixtures.pricing_options.filter(option => option.product_id === fixture.product_id),
    identity: { persistent_identifier: true, match_keys: [householdKey] },
  };
  const validate = await compile('/schemas/core/product.json');
  assert.equal(validate(product), false, 'identity_match without trusted_match');
  const withTmp = { ...product, trusted_match: { context_match: false, identity_match: true } };
  assert.equal(validate(withTmp), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...withTmp, trusted_match: { context_match: false, identity_match: false } }),
    false,
    'identity_match: false contradicts a forwarded key'
  );
});

test('TMP provider registration uses the match-key shape', async () => {
  const validate = await compile('/schemas/trusted-match/provider-registration.json');
  const registration = {
    provider_id: 'buyer_im',
    endpoint: 'https://tmp.example-buyer.com',
    identity_match: true,
    countries: ['US'],
    uid_types: ['maid', 'id5'],
    match_keys: [{ uid_type: 'maid', vendor: { domain: 'example-graph.com' }, scopes: ['households'], uses: ['identity_match'] }],
  };
  assert.equal(validate(registration), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...registration, match_keys: [{ ...registration.match_keys[0], uses: ['identity_match', 'audience_include'] }] }),
    false
  );
  assert.equal(
    validate({ ...registration, match_keys: [{ ...registration.match_keys[0], property_types: ['website'] }] }),
    false
  );
});

test('seller-wide match keys require the media_buy.match_keys feature', async () => {
  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  const capabilities = experimental_features => ({
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    ...(experimental_features && { experimental_features }),
    media_buy: { supported_match_keys: [{ ...householdKey, property_types: ['mobile_app', 'ctv_app'] }] },
  });
  assert.equal(validate(capabilities(['media_buy.match_keys'])), true, JSON.stringify(validate.errors));
  assert.equal(validate(capabilities()), false);
  assert.equal(validate(capabilities(['media_buy.product_identity'])), false);
});
