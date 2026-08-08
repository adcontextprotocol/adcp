const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const errorSchema = JSON.parse(fs.readFileSync(
  path.join(root, 'static', 'schemas', 'source', 'core', 'error.json'),
  'utf8',
));

describe('error.retry_after integer emission and compatible decoding contract', () => {
  it('preserves the released number wire type and bounds', () => {
    const retryAfter = errorSchema.properties.retry_after;
    assert.equal(retryAfter.type, 'number');
    assert.equal(retryAfter.minimum, 1);
    assert.equal(retryAfter.maximum, 3600);
  });

  it('requires integer emission while pinning legacy fractional decoding', () => {
    const description = errorSchema.properties.retry_after.description;
    assert.match(description, /producers MUST emit an integer/i);
    assert.match(description, /backward compatibility/i);
    assert.match(description, /consumers receiving one MUST round up/i);
    assert.match(description, /before clamping/i);
  });
});
