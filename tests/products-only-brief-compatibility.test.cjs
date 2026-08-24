const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.join(__dirname, '..');
const SOURCE_SCHEMA_ROOT = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const VECTOR_PATH = path.join(
  REPO_ROOT,
  'static',
  'compliance',
  'source',
  'test-vectors',
  'products-only-brief-compatibility',
  'vectors.json',
);
const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));

function loadSchemaUri(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Unexpected schema URI: ${uri}`);
  const relative = uri.slice('/schemas/'.length);
  const versionMatch = relative.match(/^(\d+\.\d+\.\d+)\/(.+)$/);
  const filename = versionMatch
    ? path.join(REPO_ROOT, 'dist', 'schemas', versionMatch[1], versionMatch[2])
    : path.join(SOURCE_SCHEMA_ROOT, relative);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

async function compileSchema(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadSchemaUri });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

function validationMessage(validate) {
  return (validate.errors || [])
    .map(error => `${error.instancePath}: ${error.message}`)
    .join('; ');
}

test('2.5, 3.0, and 3.1 preserve products-only brief discovery through an explicit legacy purchase continuation', async () => {
  const [validateCompact, validateContinuationInput] = await Promise.all([
    compileSchema(loadSchemaUri('/schemas/media-buy/request-proposals-response.json')),
    compileSchema(loadSchemaUri('/schemas/media-buy/legacy-purchase-continuation-input.json')),
  ]);
  assert.equal(
    validateCompact.schema.properties.purchase_continuation['x-compatibility-projection-only'],
    true,
    'native sellers must be able to distinguish the SDK-only compatibility branch',
  );
  assert.match(
    validateCompact.schema.properties.purchase_continuation['x-adcp-validation']
      .verifier_constraints.listed_product_binding,
    /product_ids equals the set of products\[\]\.product_id/,
    'listed purchase requires semantic cross-array product binding',
  );

  for (const vector of vectors.cases) {
    const prefix = `/schemas/${vector.source_version}/media-buy`;
    const [validateDiscoveryRequest, validateDiscoveryResponse, validateCreateRequest] = await Promise.all([
      compileSchema(loadSchemaUri(`${prefix}/get-products-request.json`)),
      compileSchema(loadSchemaUri(`${prefix}/get-products-response.json`)),
      compileSchema(loadSchemaUri(`${prefix}/create-media-buy-request.json`)),
    ]);

    assert.equal(
      validateDiscoveryRequest(vector.legacy_request),
      true,
      `${vector.source_version} discovery request: ${validationMessage(validateDiscoveryRequest)}`,
    );
    assert.equal(
      validateDiscoveryResponse(vector.legacy_response),
      true,
      `${vector.source_version} products-only response: ${validationMessage(validateDiscoveryResponse)}`,
    );
    assert.equal(vector.legacy_response.proposals, undefined);

    assert.equal(
      validateCompact(vector.compact_projection),
      true,
      `${vector.source_version} compact projection: ${validationMessage(validateCompact)}`,
    );
    assert.equal(vector.compact_projection.outcome, 'products_available');
    assert.equal(vector.compact_projection.proposals, undefined);
    assert.equal(vector.compact_projection.feed_version, undefined);
    assert.equal(vector.compact_projection.pricing_version, undefined);
    assert.equal(vector.compact_projection.purchase_continuation.kind, 'legacy_create');
    assert.equal(
      validateContinuationInput(vector.continuation_input),
      true,
      `${vector.source_version} coordinator input: ${validationMessage(validateContinuationInput)}`,
    );
    assert.equal(
      vector.continuation_input.continuation_token,
      vector.compact_projection.purchase_continuation.continuation_token,
      `${vector.source_version} redemption uses the returned opaque token`,
    );
    const expectedLosses = [
      'feed_version_not_atomic',
      'pricing_version_not_atomic',
      ...(vector.source_version.startsWith('2.5') ? ['mutation_idempotency_not_guaranteed'] : []),
    ];
    assert.deepEqual(new Set(vector.compact_projection.purchase_continuation.losses), new Set(expectedLosses));
    assert.deepEqual(
      new Set(vector.continuation_input.accepted_losses),
      new Set(vector.compact_projection.purchase_continuation.losses),
      `${vector.source_version} follow-up accepts every named loss`,
    );
    assert.deepEqual(
      vector.continuation_input.selected_product_ids,
      vector.compact_projection.purchase_continuation.product_ids,
      `${vector.source_version} follow-up selection remains bound to the continuation`,
    );

    const sourceProductId = vector.legacy_response.products[0].product_id;
    assert.equal(vector.compact_projection.products[0].product_id, sourceProductId);
    assert.equal(
      vector.compact_projection.products[0].pricing_options[0].pricing_option_id,
      vector.legacy_response.products[0].pricing_options[0].pricing_option_id,
    );
    assert.ok(vector.compact_projection.purchase_continuation.continuation_token);
    assert.ok(vector.compact_projection.purchase_continuation.continuation_expires_at);
    assert.equal(vector.continuation_input.legacy_create_request.packages[0].product_id, sourceProductId);
    assert.equal(
      validateCreateRequest(vector.continuation_input.legacy_create_request),
      true,
      `${vector.source_version} legacy purchase: ${validationMessage(validateCreateRequest)}`,
    );

    const missingLossConsent = structuredClone(vector.continuation_input);
    missingLossConsent.accepted_losses.pop();
    assert.notDeepEqual(
      new Set(missingLossConsent.accepted_losses),
      new Set(vector.compact_projection.purchase_continuation.losses),
      `${vector.source_version} coordinator rejects incomplete consent before mutation`,
    );

    const substitutedProduct = structuredClone(vector.continuation_input);
    substitutedProduct.selected_product_ids = ['product-from-another-discovery'];
    assert.equal(
      substitutedProduct.selected_product_ids.every(productId =>
        vector.compact_projection.purchase_continuation.product_ids.includes(productId)),
      false,
      `${vector.source_version} coordinator rejects product substitution before mutation`,
    );

    const mismatchedPackage = structuredClone(vector.continuation_input);
    mismatchedPackage.legacy_create_request.packages[0].product_id = 'product-from-another-discovery';
    assert.notDeepEqual(
      new Set(mismatchedPackage.legacy_create_request.packages.map(pkg => pkg.product_id)),
      new Set(mismatchedPackage.selected_product_ids),
      `${vector.source_version} coordinator binds explicit packages to the selected product set`,
    );

    if (!vector.source_version.startsWith('2.5')) {
      const reboundAccount = structuredClone(vector.continuation_input);
      reboundAccount.legacy_create_request.account = { account_id: 'another-account' };
      assert.notDeepEqual(
        reboundAccount.legacy_create_request.account,
        reboundAccount.account,
        `${vector.source_version} coordinator rejects cross-account request substitution`,
      );
    }

    const noAcceptanceDeclaration = structuredClone(vector.compact_projection);
    delete noAcceptanceDeclaration.purchase_continuation.requires_explicit_acceptance;
    assert.equal(
      validateCompact(noAcceptanceDeclaration),
      false,
      `${vector.source_version} must declare that explicit caller acceptance is required`,
    );

    const noSourceVersion = structuredClone(vector.compact_projection);
    delete noSourceVersion.purchase_continuation.source_adcp_version;
    assert.equal(
      validateCompact(noSourceVersion),
      false,
      `${vector.source_version} continuation must identify the established source version`,
    );

    for (const unsupportedVersion of ['3.2', '4.0', '99.1', '2.5-rc.1']) {
      const unsupportedSource = structuredClone(vector.compact_projection);
      unsupportedSource.purchase_continuation.source_adcp_version = unsupportedVersion;
      assert.equal(
        validateCompact(unsupportedSource),
        false,
        `${unsupportedVersion} is outside the released legacy compatibility window`,
      );
    }

    if (vector.source_version.startsWith('2.5')) {
      const missingIdempotencyLoss = structuredClone(vector.compact_projection);
      missingIdempotencyLoss.purchase_continuation.losses = [
        'feed_version_not_atomic',
        'pricing_version_not_atomic',
      ];
      assert.equal(
        validateCompact(missingIdempotencyLoss),
        false,
        '2.5 continuation must disclose that mutation idempotency is not guaranteed',
      );
    }

    const fabricatedFence = structuredClone(vector.compact_projection);
    fabricatedFence.feed_version = `synthetic-${vector.source_version}`;
    assert.equal(validateCompact(fabricatedFence), false, `${vector.source_version} must not fabricate a feed fence`);
  }
});

test('listed_purchase uses only seller-issued account fences and ordinary buy_products', async () => {
  const [validateCompact, validateBuyProducts] = await Promise.all([
    compileSchema(loadSchemaUri('/schemas/media-buy/request-proposals-response.json')),
    compileSchema(loadSchemaUri('/schemas/media-buy/buy-products-request.json')),
  ]);

  for (const vector of vectors.listed_purchase_cases) {
    assert.equal(validateCompact(vector.compact_projection), true, validationMessage(validateCompact));
    assert.equal(validateBuyProducts(vector.buy_products_request), true, validationMessage(validateBuyProducts));
    const continuation = vector.compact_projection.purchase_continuation;
    assert.equal(continuation.kind, 'listed_purchase');
    assert.equal(continuation.cache_scope, 'account');
    assert.equal(vector.buy_products_request.feed_version, continuation.feed_version);
    assert.equal(vector.buy_products_request.pricing_version, continuation.pricing_version);
    assert.deepEqual(
      new Set(vector.buy_products_request.purchases.map(purchase => purchase.product_id)),
      new Set(continuation.product_ids),
    );

    const substitutedPurchase = structuredClone(vector.buy_products_request);
    substitutedPurchase.purchases[0].product_id = 'unfenced-product';
    assert.notDeepEqual(
      new Set(substitutedPurchase.purchases.map(purchase => purchase.product_id)),
      new Set(continuation.product_ids),
      'listed purchase semantic binding rejects an unfenced product',
    );
  }
});

test('a 3.2 seller keeps products-only legacy discovery executable through its legacy create facade', async () => {
  const [validateDiscoveryRequest, validateDiscoveryResponse, validateCreateRequest] = await Promise.all([
    compileSchema(loadSchemaUri('/schemas/media-buy/get-products-request.json')),
    compileSchema(loadSchemaUri('/schemas/media-buy/get-products-response.json')),
    compileSchema(loadSchemaUri('/schemas/media-buy/create-media-buy-request.json')),
  ]);

  for (const reverse of vectors.reverse_compatibility_cases) {
    const source = vectors.cases[reverse.source_case_index];
    assert.equal(validateDiscoveryRequest(source.legacy_request), true, validationMessage(validateDiscoveryRequest));
    assert.equal(validateDiscoveryResponse(source.legacy_response), true, validationMessage(validateDiscoveryResponse));
    assert.equal(
      validateCreateRequest(source.continuation_input.legacy_create_request),
      true,
      validationMessage(validateCreateRequest),
    );
    assert.equal(source.legacy_response.proposals, undefined);
    assert.equal(
      source.continuation_input.legacy_create_request.packages[0].product_id,
      source.legacy_response.products[0].product_id,
    );
  }
});
