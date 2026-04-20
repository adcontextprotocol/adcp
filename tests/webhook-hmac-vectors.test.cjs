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

  it('every vector and rejection_vector has a unique kebab-case id', () => {
    const allVectors = [...data.vectors, ...data.rejection_vectors];
    const seen = new Set();
    allVectors.forEach((v, i) => {
      assert.equal(typeof v.id, 'string', `vector at index ${i} missing id field`);
      assert.match(v.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id "${v.id}" at index ${i} must be kebab-case`);
      assert.ok(!seen.has(v.id), `duplicate vector id: ${v.id}`);
      seen.add(v.id);
    });
  });

  it('ships a WARNING that the test secret is not for production', () => {
    assert.equal(typeof data.WARNING, 'string', 'top-level WARNING field MUST be present');
    assert.ok(/production/i.test(data.WARNING), 'WARNING must reference production explicitly');
    assert.equal(data.secret.length, 64, 'test secret MUST be a 64-hex-char (256-bit) value');
    assert.ok(/^[0-9a-f]{64}$/.test(data.secret), 'test secret MUST be lowercase hex');
  });

  it('includes secret-rejection vectors for weak configurations', () => {
    assert.ok(Array.isArray(data.secret_rejection_vectors),
      'secret_rejection_vectors must be present');
    assert.ok(data.secret_rejection_vectors.length >= 2,
      'must cover at least length-below-minimum and zero-entropy cases');
    const shortSecret = data.secret_rejection_vectors.find(
      v => typeof v.secret === 'string' && v.secret.length < 32,
    );
    assert.ok(shortSecret, 'must include a sub-32-byte secret rejection vector');
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
    const compact = data.vectors.find(v => v.id === 'compact-js-style');
    const spaced = data.vectors.find(v => v.id === 'spaced-python-default');
    assert.ok(compact, 'must have vector id "compact-js-style"');
    assert.ok(spaced, 'must have vector id "spaced-python-default"');
    assert.notEqual(compact.expected_signature, spaced.expected_signature,
      'compact and spaced JSON must produce different signatures — this is the whole point of raw body signing');
  });

  describe('rejection vectors', () => {
    for (const vector of data.rejection_vectors) {
      it(`should not compute to the claimed signature: ${vector.description}`, () => {
        // Rejection vectors where `signature` is not a numeric-HMAC value
        // (e.g., structural-rejection cases like empty/null/"sha256=valid_but_irrelevant")
        // are not computationally checkable — they're documented for verifier implementers.
        if (vector.signature == null || vector.signature === '') return;
        if (!/^sha(256|512)=[0-9a-f]+$/.test(vector.signature)) return;
        if (typeof vector.timestamp !== 'number') return;

        const message = `${vector.timestamp}.${vector.raw_body}`;
        const hex = crypto.createHmac('sha256', data.secret).update(message, 'utf8').digest('hex');
        const computed = `sha256=${hex}`;

        assert.notEqual(computed, vector.signature,
          `Rejection vector "${vector.description}" must not match a correctly-computed HMAC over the claimed raw_body — otherwise the test vector collapses into a positive case`);
      });
    }
  });
});
