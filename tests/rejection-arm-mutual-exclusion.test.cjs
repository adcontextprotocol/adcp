#!/usr/bin/env node
/**
 * Rejection-arm vs errors[] mutual-exclusion test.
 *
 * The wire-placement guidance on `GOVERNANCE_DENIED` (and the parallel
 * `CreativeRejected` rule) declares that when a task response defines a
 * structured rejection arm, the arm IS the canonical denial shape — sellers
 * MUST NOT additionally emit the error code in `errors[]`. The schema
 * encodes this with `not: { required: ["errors"] }` on each rejection arm.
 *
 * This test is the conformance check that the schema constraint actually
 * fires. If the constraint regresses (e.g. a future refactor drops the
 * `not` block), this test breaks before the storyboards do.
 *
 * Closes adcontextprotocol/adcp#3998.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '..', 'static/schemas/source');

async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
    return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  }
  throw new Error(`Cannot load external schema: ${uri}`);
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(message, type = 'info') {
  const colors = { info: '\x1b[0m', success: '\x1b[32m', error: '\x1b[31m' };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

const validatorPromises = new Map();

async function compile(schemaId) {
  if (validatorPromises.has(schemaId)) {
    return validatorPromises.get(schemaId);
  }

  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
  addFormats(ajv);
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validatorPromise = ajv.compileAsync(schema);
  validatorPromises.set(schemaId, validatorPromise);
  return validatorPromise;
}

async function expectAccept(schemaId, data, label) {
  totalTests++;
  const validate = await compile(schemaId);
  if (validate(data)) {
    log(`  ✓ ${label}`, 'success');
    passedTests++;
    return;
  }
  log(`  ✗ ${label} — expected accept, got reject`, 'error');
  for (const e of validate.errors || []) log(`      ${e.instancePath || 'root'}: ${e.message} (${e.schemaPath})`, 'error');
  failedTests++;
}

async function expectReject(schemaId, data, label) {
  totalTests++;
  const validate = await compile(schemaId);
  if (!validate(data)) {
    log(`  ✓ ${label}`, 'success');
    passedTests++;
    return;
  }
  log(`  ✗ ${label} — expected reject, got accept`, 'error');
  failedTests++;
}

async function runTests() {
  log('\n=== Rejection-arm mutual-exclusion ===\n');

  log('AcquireRightsRejected (brand/acquire-rights-response.json)');
  const rejected = {
    status: 'completed',
    rights_id: 'rgt_123',
    rights_status: 'rejected',
    brand_id: 'brnd_456',
    reason: 'Denied by governance plan plan_strict: Proposed spend 1250 USD exceeds plan budget 50 USD.'
  };
  await expectAccept('/schemas/brand/acquire-rights-response.json', rejected, 'canonical AcquireRightsRejected (envelope status + rights_status + reason, no errors[])');

  await expectReject('/schemas/brand/acquire-rights-response.json', {
    ...rejected,
    errors: [{ code: 'GOVERNANCE_DENIED', message: 'Denied by governance' }]
  }, 'AcquireRightsRejected with errors[] populated — schema MUST reject (not: required: [errors])');

  log('\nCreativeRejected (brand/creative-approval-response.json)');
  const creativeRejected = {
    status: 'completed',
    approval_status: 'rejected',
    rights_id: 'rgt_123',
    reason: 'Creative violates the seller advertising_policies: depiction of competitor brand.'
  };
  await expectAccept('/schemas/brand/creative-approval-response.json', creativeRejected, 'canonical CreativeRejected (envelope status + approval_status + reason, no errors[])');

  await expectReject('/schemas/brand/creative-approval-response.json', {
    ...creativeRejected,
    errors: [{ code: 'GOVERNANCE_DENIED', message: 'Denied' }]
  }, 'CreativeRejected with errors[] populated — schema MUST reject (not: required: [errors])');

  log('\nGetProductsRejected (media-buy/get-products-rejected.json)');
  const productsRejected = {
    status: 'rejected',
    reason: 'The requested budget is below the minimum for this inventory.',
    suggestions: ['Increase the campaign budget or request display inventory.']
  };
  await expectAccept('/schemas/media-buy/get-products-rejected.json', productsRejected, 'canonical GetProductsRejected (status + reason, no products/errors)');
  await expectAccept('/schemas/media-buy/get-products-response.json', productsRejected, 'canonical get_products response accepts the rejected arm');
  await expectAccept('/schemas/core/async-response-data.json', productsRejected, 'GetProductsRejected is included in the task-result union');

  await expectAccept('/schemas/core/async-response-data.json', {
    status: 'rejected',
    media_buy_id: 'mb_rejected',
    confirmed_at: '2026-08-05T00:00:00Z',
    revision: 1,
    packages: []
  }, 'task-result union preserves legacy create_media_buy rejected lifecycle status');

  const taskResultEnvelope = {
    task_id: 'task_get_products_rejected',
    task_type: 'get_products',
    protocol: 'media-buy',
    status: 'completed',
    created_at: '2026-08-05T00:00:00Z',
    updated_at: '2026-08-05T00:00:01Z',
    result: productsRejected
  };
  await expectAccept('/schemas/core/tasks-get-response.json', taskResultEnvelope, 'tasks/get accepts a canonical get_products rejection');
  await expectAccept('/schemas/protocol/get-task-status-response.json', taskResultEnvelope, 'get_task_status accepts a canonical get_products rejection');

  const mixedRejectedResult = {
    ...productsRejected,
    products: [],
    cache_scope: 'public'
  };
  await expectReject('/schemas/core/tasks-get-response.json', {
    ...taskResultEnvelope,
    result: mixedRejectedResult
  }, 'tasks/get rejects a mixed get_products rejection result');
  await expectReject('/schemas/protocol/get-task-status-response.json', {
    ...taskResultEnvelope,
    result: mixedRejectedResult
  }, 'get_task_status rejects a mixed get_products rejection result');

  const createMediaBuyRejected = {
    status: 'rejected',
    media_buy_id: 'mb_rejected',
    confirmed_at: '2026-08-05T00:00:00Z',
    revision: 1,
    packages: []
  };
  await expectAccept('/schemas/core/tasks-get-response.json', {
    ...taskResultEnvelope,
    task_type: 'create_media_buy',
    result: createMediaBuyRejected
  }, 'tasks/get preserves legacy create_media_buy rejected lifecycle status');

  const webhookEnvelope = {
    idempotency_key: 'whk_01HW9D2T3VXQ5M7K9N1P3R5S7U',
    operation_id: 'op_get_products_rejected',
    task_id: taskResultEnvelope.task_id,
    task_type: 'get_products',
    protocol: 'media-buy',
    status: 'completed',
    timestamp: '2026-08-05T00:00:01Z',
    result: productsRejected
  };
  await expectAccept('/schemas/core/mcp-webhook-payload.json', webhookEnvelope, 'MCP webhook accepts a canonical get_products rejection');
  await expectReject('/schemas/core/mcp-webhook-payload.json', {
    ...webhookEnvelope,
    result: mixedRejectedResult
  }, 'MCP webhook rejects a mixed get_products rejection result');
  await expectAccept('/schemas/core/mcp-webhook-payload.json', {
    ...webhookEnvelope,
    task_type: 'create_media_buy',
    result: createMediaBuyRejected
  }, 'MCP webhook preserves legacy create_media_buy rejected lifecycle status');

  await expectReject('/schemas/media-buy/get-products-rejected.json', {
    ...productsRejected,
    products: []
  }, 'GetProductsRejected with products[] — schema MUST reject');
  await expectReject('/schemas/media-buy/get-products-response.json', {
    ...productsRejected,
    products: [],
    cache_scope: 'public'
  }, 'canonical get_products response rejects a mixed rejected/products arm');
  await expectReject('/schemas/media-buy/get-products-response.json', {
    status: 'completed',
    products: [],
    cache_scope: 'public',
    reason: productsRejected.reason
  }, 'completed get_products response rejects rejection-only reason');

  await expectReject('/schemas/media-buy/get-products-rejected.json', {
    ...productsRejected,
    proposals: []
  }, 'GetProductsRejected with proposals[] — schema MUST reject');

  await expectReject('/schemas/media-buy/get-products-rejected.json', {
    ...productsRejected,
    errors: [{ code: 'POLICY_VIOLATION', message: 'Declined' }]
  }, 'GetProductsRejected with errors[] — schema MUST reject');

  await expectReject('/schemas/media-buy/get-products-rejected.json', {
    ...productsRejected,
    adcp_error: { code: 'POLICY_VIOLATION', message: 'Declined' }
  }, 'GetProductsRejected with envelope adcp_error — schema MUST reject');
  await expectReject('/schemas/media-buy/get-products-rejected.json', {
    ...productsRejected,
    suggestions: Array.from({ length: 21 }, (_, index) => `Alternative ${index + 1}`)
  }, 'GetProductsRejected with more than 20 suggestions — schema MUST reject');
  await expectReject('/schemas/media-buy/get-products-rejected.json', {
    ...productsRejected,
    suggestions: []
  }, 'GetProductsRejected with empty suggestions — schema MUST reject');

  const forbiddenRejectedFields = {
    incomplete: [{ scope: 'products', description: 'Partial' }],
    cache_scope: 'public',
    filter_diagnostics: {},
    refinement_applied: [{ scope: 'request', status: 'unable' }],
    unchanged: true,
    wholesale_feed_version: 'feed_v1',
    pricing_version: 'pricing_v1',
    pagination: { has_more: false }
  };
  for (const [forbidden, value] of Object.entries(forbiddenRejectedFields)) {
    await expectReject('/schemas/media-buy/get-products-rejected.json', {
      ...productsRejected,
      [forbidden]: value
    }, `GetProductsRejected with ${forbidden} — schema MUST reject`);
    await expectReject('/schemas/media-buy/get-products-response.json', {
      ...productsRejected,
      [forbidden]: value,
      ...(forbidden === 'unchanged' && {
        wholesale_feed_version: 'feed_v1',
        cache_scope: 'public'
      })
    }, `canonical get_products response rejects rejected arm with ${forbidden}`);
  }

  log('\nCompliance controller forcing');
  const forceRejectedRequest = {
    adcp_version: '3.2',
    adcp_major_version: 3,
    scenario: 'force_get_products_arm',
    account: {
      brand: { domain: 'acmeoutdoor.example' },
      operator: 'pinnacle-agency.example',
      sandbox: true
    },
    params: {
      arm: 'rejected',
      reason: productsRejected.reason,
      suggestions: productsRejected.suggestions
    }
  };
  await expectAccept('/schemas/compliance/comply-test-controller-request.json', forceRejectedRequest, 'force_get_products_arm accepts a rejected directive with reason');
  await expectReject('/schemas/compliance/comply-test-controller-request.json', {
    ...forceRejectedRequest,
    params: { arm: 'rejected' }
  }, 'force_get_products_arm rejected directive without reason — schema MUST reject');
  await expectReject('/schemas/compliance/comply-test-controller-request.json', {
    ...forceRejectedRequest,
    params: {
      ...forceRejectedRequest.params,
      suggestions: Array.from({ length: 21 }, (_, index) => `Alternative ${index + 1}`)
    }
  }, 'force_get_products_arm rejected directive with more than 20 suggestions — schema MUST reject');
  await expectReject('/schemas/compliance/comply-test-controller-request.json', {
    ...forceRejectedRequest,
    params: {
      ...forceRejectedRequest.params,
      suggestions: []
    }
  }, 'force_get_products_arm rejected directive with empty suggestions — schema MUST reject');
  await expectReject('/schemas/compliance/comply-test-controller-request.json', {
    ...forceRejectedRequest,
    scenario: 'force_create_media_buy_arm',
    params: { arm: 'rejected', reason: productsRejected.reason }
  }, 'force_create_media_buy_arm rejects the get_products-only rejected arm');

  const forceRejectedResponse = {
    status: 'completed',
    success: true,
    forced: {
      arm: 'rejected',
      reason: productsRejected.reason,
      suggestions: productsRejected.suggestions
    }
  };
  await expectAccept('/schemas/compliance/comply-test-controller-response.json', forceRejectedResponse, 'controller response accepts a rejected directive echo with reason');
  await expectReject('/schemas/compliance/comply-test-controller-response.json', {
    ...forceRejectedResponse,
    forced: { ...forceRejectedResponse.forced, task_id: 'task_wrong_arm' }
  }, 'controller rejected directive echo with task_id — schema MUST reject');
  await expectReject('/schemas/compliance/comply-test-controller-response.json', {
    status: 'completed',
    success: true,
    forced: { arm: 'rejected' }
  }, 'controller rejected directive echo without reason — schema MUST reject');

  log(`\n--- ${passedTests}/${totalTests} passed ---\n`);
  if (failedTests > 0) process.exit(1);
}

runTests().catch(err => {
  log(`Test execution failed: ${err.message}`, 'error');
  process.exit(1);
});
