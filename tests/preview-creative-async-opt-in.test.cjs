const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const schemaDir = path.join(__dirname, '..', 'static', 'schemas', 'source', 'creative');
const request = JSON.parse(fs.readFileSync(path.join(schemaDir, 'preview-creative-request.json'), 'utf8'));
const response = JSON.parse(fs.readFileSync(path.join(schemaDir, 'preview-creative-response.json'), 'utf8'));

describe('preview_creative opt-in async contract', () => {
  it('defaults the request opt-in to false and forbids unilateral async', () => {
    assert.equal(request.properties.allow_async.type, 'boolean');
    assert.equal(request.properties.allow_async.default, false);
    assert.match(request.properties.allow_async.description, /MUST NOT return the submitted shape/);
  });

  it('adds one submitted task arm without changing build_creative', () => {
    const submitted = response.oneOf.find((arm) => arm.title === 'PreviewCreativeSubmitted');
    assert.ok(submitted);
    assert.deepEqual(submitted.required, ['status', 'task_id']);
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
});
