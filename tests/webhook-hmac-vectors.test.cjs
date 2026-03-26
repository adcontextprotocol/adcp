/**
 * Validates that the HMAC-SHA256 test vectors in static/test-vectors/webhook-hmac-sha256.json
 * are internally consistent — recomputes each signature and asserts it matches.
 *
 * This runs as part of spec CI to catch typos or stale vectors.
 * Client libraries (JS, Python, etc.) should also validate against these vectors
 * to ensure cross-language interop.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'webhook-hmac-sha256.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

describe('Webhook HMAC-SHA256 test vectors', () => {
  it('should have a valid structure', () => {
    assert.equal(typeof data.version, 'number', 'must have a numeric version field');
    assert.equal(data.algorithm, 'HMAC-SHA256');
    assert.ok(data.secret.length >= 32, 'secret must be at least 32 characters');
    assert.ok(Array.isArray(data.vectors), 'vectors must be an array');
    assert.ok(data.vectors.length > 0, 'must have at least one vector');
  });

  for (const vector of data.vectors) {
    if (vector.expect_mismatch) {
      it(`should reject tampered body: ${vector.description}`, () => {
        const message = `${vector.timestamp}.${vector.raw_body}`;
        const hex = crypto.createHmac('sha256', data.secret).update(message, 'utf8').digest('hex');
        const computed = `sha256=${hex}`;

        assert.notEqual(computed, vector.expected_signature,
          `Signature should NOT match for tampered vector "${vector.description}"`);
      });
    } else {
      it(`should produce correct signature: ${vector.description}`, () => {
        assert.equal(typeof vector.timestamp, 'number', 'timestamp must be a number (Unix seconds)');
        assert.equal(typeof vector.raw_body, 'string', 'raw_body must be a string');
        assert.ok(vector.expected_signature.startsWith('sha256='), 'signature must start with sha256=');

        const message = `${vector.timestamp}.${vector.raw_body}`;
        const hex = crypto.createHmac('sha256', data.secret).update(message, 'utf8').digest('hex');
        const computed = `sha256=${hex}`;

        assert.equal(computed, vector.expected_signature,
          `Signature mismatch for "${vector.description}"\n` +
          `  message: ${message.substring(0, 80)}...\n` +
          `  expected: ${vector.expected_signature}\n` +
          `  computed: ${computed}`
        );
      });
    }
  }

  it('should produce different signatures for compact vs spaced JSON', () => {
    const compact = data.vectors.find(v => v.description.includes('compact'));
    const spaced = data.vectors.find(v => v.description.includes('spaced'));
    assert.ok(compact, 'must have a compact JSON vector');
    assert.ok(spaced, 'must have a spaced JSON vector');
    assert.notEqual(compact.expected_signature, spaced.expected_signature,
      'compact and spaced JSON must produce different signatures — this is the whole point of raw body signing');
  });
});
