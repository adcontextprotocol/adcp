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

async function compile(schemaId) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
  addFormats(ajv);
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return ajv.compileAsync(schema);
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
    rights_id: 'rgt_123',
    status: 'rejected',
    brand_id: 'brnd_456',
    reason: 'Denied by governance plan plan_strict: Proposed spend 1250 USD exceeds plan budget 50 USD.'
  };
  await expectAccept('/schemas/brand/acquire-rights-response.json', rejected, 'canonical AcquireRightsRejected (status + reason, no errors[])');

  await expectReject('/schemas/brand/acquire-rights-response.json', {
    ...rejected,
    errors: [{ code: 'GOVERNANCE_DENIED', message: 'Denied by governance' }]
  }, 'AcquireRightsRejected with errors[] populated — schema MUST reject (not: required: [errors])');

  log('\nCreativeRejected (brand/creative-approval-response.json)');
  const creativeRejected = {
    status: 'rejected',
    rights_id: 'rgt_123',
    reason: 'Creative violates the seller advertising_policies: depiction of competitor brand.'
  };
  await expectAccept('/schemas/brand/creative-approval-response.json', creativeRejected, 'canonical CreativeRejected (status + reason, no errors[])');

  await expectReject('/schemas/brand/creative-approval-response.json', {
    ...creativeRejected,
    errors: [{ code: 'GOVERNANCE_DENIED', message: 'Denied' }]
  }, 'CreativeRejected with errors[] populated — schema MUST reject (not: required: [errors])');

  log(`\n--- ${passedTests}/${totalTests} passed ---\n`);
  if (failedTests > 0) process.exit(1);
}

runTests().catch(err => {
  log(`Test execution failed: ${err.message}`, 'error');
  process.exit(1);
});
