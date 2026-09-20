const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const schemaRoot = path.join(__dirname, '..', 'static', 'schemas', 'source');
const readSchema = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(schemaRoot, relativePath), 'utf8')
);
const request = readSchema('creative/get-creative-features-request.json');
const response = readSchema('creative/get-creative-features-response.json');

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  loadSchema: async (uri) => {
    if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
    return readSchema(uri.replace('/schemas/', ''));
  }
});
addFormats(ajv);

async function compile(schemaId) {
  const existing = ajv.getSchema(schemaId);
  if (existing) return existing;
  return ajv.compileAsync(readSchema(schemaId.replace('/schemas/', '')));
}

const creativeManifest = {
  format_kind: 'display_tag',
  assets: {
    tag_url: {
      asset_type: 'url',
      url: 'https://creative.example.test/evaluations/creative-7604.html'
    }
  }
};

describe('get_creative_features retry and reconciliation contract', () => {
  it('classifies provider evaluation as replay-protected consequential work', () => {
    assert.equal(request['x-mutates-state'], true);
    assert.ok(request.required.includes('idempotency_key'));
    assert.equal(request.properties.idempotency_key.minLength, 16);
    assert.match(request.properties.idempotency_key.description, /at least 24 hours/);
    assert.equal(
      request.properties.push_notification_config.$ref,
      '/schemas/core/push-notification-config.json'
    );
  });

  it('requires a valid idempotency key on every request', async () => {
    const validate = await compile('/schemas/creative/get-creative-features-request.json');
    const validRequest = {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440760',
      creative_manifest: creativeManifest,
      feature_ids: ['auto_redirect', 'credential_harvest']
    };

    assert.equal(validate(validRequest), true, JSON.stringify(validate.errors));
    assert.equal(validate({ creative_manifest: creativeManifest }), false);
    assert.equal(validate({ ...validRequest, idempotency_key: 'too-short' }), false);
  });

  it('requires evaluation_id on terminal success', async () => {
    const validate = await compile('/schemas/creative/get-creative-features-response.json');
    const success = {
      status: 'completed',
      evaluation_id: 'eval_sync_7604',
      results: [{ feature_id: 'auto_redirect', value: false }],
      pricing_option_id: 'standard_scan',
      vendor_cost: 0.025,
      currency: 'USD'
    };

    assert.equal(validate(success), true, JSON.stringify(validate.errors));
    const { evaluation_id, ...missingIdentity } = success;
    assert.equal(validate(missingIdentity), false);
  });

  it('admits only a bounded submitted acknowledgement with both identities', async () => {
    const validate = await compile('/schemas/creative/get-creative-features-response.json');
    const submitted = {
      status: 'submitted',
      task_id: 'task_eval_7604',
      evaluation_id: 'eval_async_7604'
    };

    assert.equal(validate(submitted), true, JSON.stringify(validate.errors));
    const { evaluation_id, ...withoutEvaluationId } = submitted;
    const { task_id, ...withoutTaskId } = submitted;
    assert.equal(validate(withoutEvaluationId), false);
    assert.equal(validate(withoutTaskId), false);
    assert.equal(validate({ ...submitted, results: [] }), false);
    assert.equal(validate({ ...submitted, vendor_cost: 0.025 }), false);

    const submittedVariant = readSchema('creative/get-creative-features-async-response-submitted.json');
    assert.deepEqual(submittedVariant.required, ['status', 'task_id', 'evaluation_id']);
  });

  it('keeps success, error, and submitted arms mutually exclusive', () => {
    assert.deepEqual(
      response.oneOf.map((arm) => arm.title),
      ['GetCreativeFeaturesSuccess', 'GetCreativeFeaturesError', 'GetCreativeFeaturesSubmitted']
    );
    assert.ok(response.oneOf.every((arm) => arm.not));
  });

  it('allows deterministic synchronous and asynchronous creative-feature results', () => {
    const completion = readSchema('compliance/task-completion-data.json');
    assert.ok(completion.anyOf.some((arm) => (
      arm.title === 'GetCreativeFeaturesCompletion'
      && arm.$ref === '/schemas/creative/get-creative-features-response.json#/oneOf/0'
    )));

    const controller = readSchema('compliance/comply-test-controller-request.json');
    const forcedArm = controller.allOf.find((branch) => (
      branch.if?.properties?.scenario?.const === 'force_get_creative_features_arm'
    ));
    assert.equal(forcedArm.then.properties.params.oneOf.length, 2);
    assert.deepEqual(forcedArm.then.properties.params.oneOf[0].required, [
      'arm',
      'task_id',
      'evaluation_id'
    ]);
    assert.deepEqual(forcedArm.then.properties.params.oneOf[1].required, [
      'arm',
      'result'
    ]);
    assert.equal(
      forcedArm.then.properties.params.oneOf[1].properties.result.$ref,
      '/schemas/creative/get-creative-features-response.json#/oneOf/0'
    );

    const asyncData = readSchema('core/async-response-data.json');
    assert.ok(asyncData.anyOf.some((arm) => (
      arm.$ref === '/schemas/creative/get-creative-features-async-response-submitted.json'
    )));
  });
});
