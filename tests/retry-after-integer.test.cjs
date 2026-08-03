const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const errorSchema = JSON.parse(fs.readFileSync(
  path.join(root, 'static', 'schemas', 'source', 'core', 'error.json'),
  'utf8',
));

describe('error.retry_after integer migration contract', () => {
  it('accepts only whole seconds within the settled bounds', () => {
    const retryAfter = errorSchema.properties.retry_after;
    assert.equal(retryAfter.type, 'integer');
    assert.equal(retryAfter.minimum, 1);
    assert.equal(retryAfter.maximum, 3600);
  });

  it('pins ceiling-before-clamp migration semantics in the schema', () => {
    const description = errorSchema.properties.retry_after.description;
    assert.match(description, /round up/i);
    assert.match(description, /before clamping/i);
    assert.match(description, /legacy finite fractional/i);
  });
});
