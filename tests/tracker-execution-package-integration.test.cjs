const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');
const DIGEST_A = `sha256:${'1'.repeat(64)}`;
const DIGEST_B = `sha256:${'2'.repeat(64)}`;

function schemaPathFromId(schemaId) {
  return path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
}

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
  return JSON.parse(fs.readFileSync(schemaPathFromId(uri), 'utf8'));
}

async function compile(schemaId) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8')));
}

const contract = {
  complete: true,
  honored: []
};

const contractDeclaration = {
  format_option_id: 'homepage_image',
  format_kind: 'image',
  params: { width: 300, height: 250 },
  tracker_execution_contract: contract
};

const contractSnapshot = {
  ...contractDeclaration,
  product_id: 'homepage_sponsorship',
  placement_refs: [{
    publisher_domain: 'daily-pulse.example',
    placement_id: 'homepage_leaderboard'
  }],
  tracker_execution_contract_digest: DIGEST_A,
  product_snapshot_digest: DIGEST_B
};

test('contract-bearing product and compact declarations require stable option identity', async () => {
  for (const schemaId of [
    '/schemas/core/product-format-declaration.json',
    '/schemas/core/canonical-format-option.json'
  ]) {
    const validate = await compile(schemaId);
    assert.equal(validate(contractDeclaration), true, JSON.stringify(validate.errors, null, 2));
    const { format_option_id: _omitted, ...withoutId } = contractDeclaration;
    assert.equal(validate(withoutId), false, `${schemaId} accepted seller authority without stable identity`);
    assert.equal(validate({ ...contractDeclaration, format_option_id: '' }), false,
      `${schemaId} accepted an empty seller-authority identity`);
  }

  const validateLegacyProduct = await compile('/schemas/core/product-format-declaration.json');
  assert.equal(validateLegacyProduct({
    format_option_id: '',
    format_kind: 'image',
    params: { width: 300, height: 250 }
  }), true, 'legacy non-contract Product declarations retain 3.1 empty-ID compatibility');

  const validateCompact = await compile('/schemas/core/canonical-format-option.json');
  assert.equal(validateCompact({
    publisher_domain: 'daily-pulse.example',
    format_kind: 'image',
    params: { width: 300, height: 250 }
  }), false, 'publisher-scoped compact options require their complete namespace pair');
  assert.equal(validateCompact({
    format_option_id: 'homepage_image',
    publisher_domain: 'daily-pulse.example',
    format_kind: 'image',
    params: { width: 300, height: 250 }
  }), true, JSON.stringify(validateCompact.errors, null, 2));
});

test('package snapshots pair contract, product identity, and immutable digests', async () => {
  const validate = await compile('/schemas/core/package-format-snapshot.json');
  assert.equal(validate(contractSnapshot), true, JSON.stringify(validate.errors, null, 2));

  for (const requiredField of [
    'format_option_id',
    'product_id',
    'tracker_execution_contract_digest',
    'product_snapshot_digest'
  ]) {
    const invalid = { ...contractSnapshot };
    delete invalid[requiredField];
    assert.equal(validate(invalid), false, `contract snapshot accepted without ${requiredField}`);
  }

  assert.equal(validate({
    format_kind: 'image',
    params: { width: 300, height: 250 },
    tracker_execution_contract_digest: DIGEST_A
  }), false, 'tracker contract digest cannot exist without its contract');
  assert.equal(validate({
    format_kind: 'image',
    params: { width: 300, height: 250 },
    product_snapshot_digest: DIGEST_B
  }), false, 'product snapshot digest must be paired with product identity');
  assert.equal(validate({
    ...contractSnapshot,
    placement_refs: [{ placement_id: 'homepage_leaderboard' }]
  }), false, 'new immutable placement snapshots require publisher-qualified identity');
  assert.equal(validate({
    ...contractSnapshot,
    product_snapshot_digest: 'sha256:ABC'
  }), false, 'snapshot digests use lowercase-hex SHA-256');
});

test('package and readback surfaces publish PackageFormatSnapshot rather than mutable declarations', async () => {
  const validatePackage = await compile('/schemas/core/package.json');
  assert.equal(validatePackage({
    package_id: 'pkg_homepage',
    product_id: 'homepage_sponsorship',
    formats_to_provide: [contractSnapshot],
    formats_pending: []
  }), true, JSON.stringify(validatePackage.errors, null, 2));
  assert.equal(validatePackage({
    package_id: 'pkg_homepage',
    product_id: 'homepage_sponsorship',
    formats_to_provide: [contractDeclaration]
  }), false, 'package checklist accepted a contract without immutable package identity');
  assert.equal(validatePackage({
    package_id: 'pkg_homepage',
    formats_to_provide: [contractSnapshot],
    formats_pending: []
  }), false, 'package accepted a contract snapshot without enclosing product_id');
  assert.equal(validatePackage({
    package_id: 'pkg_legacy',
    product_id: ''
  }), true, 'legacy non-contract packages retain 3.1 empty-ID compatibility');
  assert.equal(validatePackage({
    package_id: 'pkg_homepage',
    product_id: '',
    formats_to_provide: [contractSnapshot],
    formats_pending: []
  }), false, 'contract-bearing packages require a nonempty enclosing product identity');

  const validateReadback = await compile('/schemas/media-buy/get-media-buys-response.json');
  const response = {
    status: 'completed',
    media_buys: [{
      media_buy_id: 'mb_homepage',
      status: 'pending_creatives',
      currency: 'USD',
      total_budget: 1000,
      confirmed_at: '2026-08-23T12:00:00Z',
      revision: 1,
      packages: [{
        package_id: 'pkg_homepage',
        product_id: 'homepage_sponsorship',
        formats_to_provide: [contractSnapshot],
        formats_pending: []
      }]
    }]
  };
  assert.equal(validateReadback(response), true, JSON.stringify(validateReadback.errors, null, 2));
  const legacyResponse = structuredClone(response);
  legacyResponse.media_buys[0].packages = [{
    package_id: 'pkg_legacy',
    product_id: ''
  }];
  assert.equal(validateReadback(legacyResponse), true,
    'legacy non-contract package readback retains 3.1 empty-ID compatibility');
  delete response.media_buys[0].packages[0].product_id;
  assert.equal(validateReadback(response), false,
    'get_media_buys readback accepted a contract snapshot without enclosing product_id');
  response.media_buys[0].packages[0].product_id = 'homepage_sponsorship';
  response.media_buys[0].packages[0].formats_to_provide = [contractDeclaration];
  assert.equal(validateReadback(response), false,
    'get_media_buys readback accepted a mutable contract declaration in place of the snapshot');
});

test('Trusted Match receives the immutable package snapshot shape', async () => {
  const validate = await compile('/schemas/trusted-match/available-package.json');
  const available = {
    package_id: 'pkg_homepage',
    media_buy_id: 'mb_homepage',
    seller_agent: { agent_url: 'https://seller.example/mcp' },
    format_options: [contractSnapshot]
  };
  assert.equal(validate(available), true, JSON.stringify(validate.errors, null, 2));
  available.format_options = [contractDeclaration];
  assert.equal(validate(available), false,
    'Trusted Match accepted a contract-bearing format without immutable package identity');
});

test('creative and legacy projection surfaces reject seller tracker authority', async () => {
  const validateCapabilities = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  assert.equal(validateCapabilities({
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['creative'],
    creative: {
      supported_formats: [{
        capability_id: 'homepage_image_builder',
        operations: ['build'],
        format: contractDeclaration
      }]
    }
  }), false, 'creative.supported_formats leaked seller production authority');

  const validateTransformer = await compile('/schemas/core/transformer.json');
  assert.equal(validateTransformer({
    transformer_id: 'homepage_transformer',
    name: 'Homepage transformer',
    input_formats: [contractDeclaration],
    output_capability_ids: ['homepage_image_builder']
  }), false, 'transformer input_formats leaked seller production authority');

  const validateLegacyFormat = await compile('/schemas/core/format.json');
  assert.equal(validateLegacyFormat({
    format_id: { agent_url: 'https://creative.example/mcp', id: 'homepage_image' },
    name: 'Homepage image',
    canonical: { kind: 'image' },
    canonical_parameters: contractDeclaration
  }), false, 'deprecated canonical_parameters leaked seller production authority');
});

test('package snapshot is registered and all package projections reference it', () => {
  const index = JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, 'index.json'), 'utf8'));
  assert.equal(index.schemas.core.schemas['package-format-snapshot'].$ref,
    '/schemas/core/package-format-snapshot.json');

  const packageSchema = JSON.parse(fs.readFileSync(
    path.join(SCHEMA_BASE_DIR, 'core/package.json'), 'utf8'
  ));
  assert.equal(packageSchema.properties.formats_to_provide.items.$ref,
    '/schemas/core/package-format-snapshot.json');
  assert.equal(packageSchema.properties.formats_pending.items.$ref,
    '/schemas/core/package-format-snapshot.json');

  const trustedMatch = JSON.parse(fs.readFileSync(
    path.join(SCHEMA_BASE_DIR, 'trusted-match/available-package.json'), 'utf8'
  ));
  assert.equal(trustedMatch.properties.format_options.items.$ref,
    '/schemas/core/package-format-snapshot.json');
});
