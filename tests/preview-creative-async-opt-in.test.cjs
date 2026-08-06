const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const schemaRoot = path.join(__dirname, '..', 'static', 'schemas', 'source');
const creativeSchemaDir = path.join(schemaRoot, 'creative');
const request = JSON.parse(fs.readFileSync(path.join(creativeSchemaDir, 'preview-creative-request.json'), 'utf8'));
const response = JSON.parse(fs.readFileSync(path.join(creativeSchemaDir, 'preview-creative-response.json'), 'utf8'));
const taskTypes = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'enums', 'task-type.json'), 'utf8'));
const asyncData = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'core', 'async-response-data.json'), 'utf8'));

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  discriminator: true,
  loadSchema: async (uri) => {
    if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(schemaRoot, uri.replace('/schemas/', '')), 'utf8'));
  }
});
addFormats(ajv);

async function compile(schemaId) {
  const existing = ajv.getSchema(schemaId);
  if (existing) return existing;
  const schema = JSON.parse(fs.readFileSync(path.join(schemaRoot, schemaId.replace('/schemas/', '')), 'utf8'));
  return ajv.compileAsync(schema);
}

const completedPreview = {
  response_type: 'single',
  previews: [{
    preview_id: 'prev_async_001',
    renders: [{
      render_id: 'render_001',
      output_format: 'url',
      preview_url: 'https://creative.example.test/previews/prev_async_001',
      role: 'primary'
    }],
    input: { name: 'Default' }
  }]
};

describe('preview_creative opt-in async contract', () => {
  it('defaults the request opt-in to false and forbids unilateral async', () => {
    assert.equal(request.properties.allow_async.type, 'boolean');
    assert.equal(request.properties.allow_async.default, false);
    assert.match(request.properties.allow_async.description, /MUST NOT return the submitted shape/);
    assert.equal(request.properties.push_notification_config.$ref, '/schemas/core/push-notification-config.json');
  });

  it('adds one submitted task arm without changing build_creative', () => {
    const submitted = response.oneOf.find((arm) => arm.title === 'PreviewCreativeSubmitted');
    assert.ok(submitted);
    assert.deepEqual(submitted.required, ['response_type', 'status', 'task_id']);
    assert.equal(submitted.properties.response_type.const, 'submitted');
    assert.equal(submitted.properties.status.const, 'submitted');
    assert.equal(submitted.properties.task_id['x-entity'], 'task');
    assert.equal(response.oneOf.length, 4);
  });

  it('keeps submitted responses mutually exclusive with all synchronous arms', () => {
    const syncArms = response.oneOf.filter((arm) => arm.title !== 'PreviewCreativeSubmitted');
    assert.equal(syncArms.length, 3);
    for (const arm of syncArms) {
      assert.equal(arm.not.properties.status.const, 'submitted');
      assert.deepEqual(arm.not.required, ['status']);
    }
  });

  it('registers preview_creative and its terminal result with shared task infrastructure', () => {
    assert.ok(taskTypes.enum.includes('preview_creative'));
    assert.equal(taskTypes.enumDescriptions.preview_creative.includes('read-only'), true);
    assert.ok(asyncData.anyOf.some((arm) => arm.$ref === '/schemas/creative/preview-creative-response.json'));
  });

  it('validates the opt-in submit, poll, and terminal webhook lifecycle', async () => {
    const validateRequest = await compile('/schemas/creative/preview-creative-request.json');
    assert.equal(validateRequest({
      request_type: 'single',
      creative_id: 'creative_001',
      allow_async: true,
      push_notification_config: {
        url: 'https://buyer.example.test/adcp/preview-complete',
        operation_id: 'preview-op-001'
      }
    }), true, JSON.stringify(validateRequest.errors));

    const validateSubmitted = await compile('/schemas/creative/preview-creative-response.json');
    assert.equal(validateSubmitted({
      response_type: 'submitted',
      status: 'submitted',
      task_id: 'task_preview_001'
    }), true, JSON.stringify(validateSubmitted.errors));

    const taskEnvelope = {
      task_id: 'task_preview_001',
      task_type: 'preview_creative',
      protocol: 'creative',
      status: 'completed',
      created_at: '2026-08-06T12:00:00Z',
      updated_at: '2026-08-06T12:00:10Z',
      completed_at: '2026-08-06T12:00:10Z',
      result: completedPreview
    };
    const validatePoll = await compile('/schemas/protocol/get-task-status-response.json');
    assert.equal(validatePoll(taskEnvelope), true, JSON.stringify(validatePoll.errors));

    const validateWebhook = await compile('/schemas/core/mcp-webhook-payload.json');
    assert.equal(validateWebhook({
      idempotency_key: 'whk_preview_001_abcdef',
      operation_id: 'preview-op-001',
      task_id: taskEnvelope.task_id,
      task_type: taskEnvelope.task_type,
      protocol: taskEnvelope.protocol,
      status: 'completed',
      timestamp: taskEnvelope.completed_at,
      result: completedPreview
    }), true, JSON.stringify(validateWebhook.errors));
  });
});
