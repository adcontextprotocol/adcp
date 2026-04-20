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

  it('publishes the verifier-action enum used by prescriptive vectors', () => {
    assert.equal(typeof data.verifier_action_values, 'object',
      'top-level verifier_action_values map MUST be present so SDK conformance suites can resolve expected_verifier_action tokens without scraping description prose');
    assert.ok(data.verifier_action_values.accept, 'verifier_action_values.accept MUST be defined (documentation-only; see fixture description)');
    assert.ok(data.verifier_action_values['reject-malformed'],
      'verifier_action_values.reject-malformed MUST be defined');
    assert.ok(Array.isArray(data.non_conformant_outcomes) && data.non_conformant_outcomes.length > 0,
      'non_conformant_outcomes MUST enumerate outcomes that fail conformance (parser-divergence class, wrong error class, silent-discard parser modes)');
  });

  it('every vector with expected_verifier_action uses a known action token', () => {
    const enumKeys = Object.keys(data.verifier_action_values);
    for (const vector of data.vectors) {
      if (vector.expected_verifier_action === undefined) continue;
      assert.ok(typeof vector.expected_verifier_action === 'string',
        `vector "${vector.id}": expected_verifier_action MUST be a string`);
      assert.ok(enumKeys.includes(vector.expected_verifier_action),
        `vector "${vector.id}": expected_verifier_action "${vector.expected_verifier_action}" is not in verifier_action_values enum [${enumKeys.join(', ')}]`);
      if (vector.rfc9421_error_code !== undefined) {
        assert.ok(typeof vector.rfc9421_error_code === 'string' && /^webhook_[a-z_]+$/.test(vector.rfc9421_error_code),
          `vector "${vector.id}": rfc9421_error_code "${vector.rfc9421_error_code}" must match the webhook_* error taxonomy in security.mdx`);
      }
    }
  });

  it('at least one vector carries expected_verifier_action so the enum has a live consumer', () => {
    const consumers = data.vectors.filter(v => v.expected_verifier_action !== undefined);
    assert.ok(consumers.length > 0,
      'at least one vector MUST carry expected_verifier_action — otherwise verifier_action_values drifts into an orphaned enum with no fixture exercising it');
  });

  it('duplicate-keys-conflicting-values fixture exists by id (security.mdx references this exact id)', () => {
    const vector = data.vectors.find(v => v.id === 'duplicate-keys-conflicting-values');
    assert.ok(vector, 'duplicate-keys-conflicting-values fixture MUST exist — security.mdx §duplicate-object-keys and the 9421 webhook verifier checklist (step 14) both reference this id; renaming without updating the spec breaks cross-SDK conformance suites');
    assert.equal(vector.expected_verifier_action, 'reject-malformed',
      'duplicate-keys-conflicting-values expected_verifier_action MUST be "reject-malformed" — this is the load-bearing assertion that the MUST-reject clause in security.mdx is actually probed by the fixture');
    assert.equal(vector.rfc9421_error_code, 'webhook_body_malformed',
      'duplicate-keys-conflicting-values rfc9421_error_code MUST be "webhook_body_malformed" — matches the error taxonomy row in security.mdx');
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

  describe('signer-side fixtures', () => {
    it('signer_side object is present with rejection_vectors, positive_vectors, and action_values', () => {
      assert.equal(typeof data.signer_side, 'object',
        'signer_side object MUST be present — conformance suites rely on this partition to separate signer-facing fixtures from verifier-facing fixtures. The signer-side MUST in security.mdx §duplicate-object-keys is unverifiable on the wire, so out-of-band interop testing against these fixtures is the enforcement path.');
      assert.ok(Array.isArray(data.signer_side.rejection_vectors),
        'signer_side.rejection_vectors MUST be an array');
      assert.ok(Array.isArray(data.signer_side.positive_vectors),
        'signer_side.positive_vectors MUST be an array — a negative-only fixture set lets a signer that rejects everything trivially pass conformance; the positive vectors assert the happy path');
      assert.equal(typeof data.signer_side.action_values, 'object',
        'signer_side.action_values enum MUST be defined so downstream harnesses resolve expected_signer_action tokens from a single source of truth');
    });

    it('rejection_vectors covers the shape-classes the signer MUST handle', () => {
      assert.ok(data.signer_side.rejection_vectors.length >= 4,
        'rejection_vectors MUST cover at least four shape-classes: top-level, plain-nested, array-contained, and three-deep — fewer vectors let hand-rolled walkers with shape or depth blind spots ship silently');
      const ids = data.signer_side.rejection_vectors.map(v => v.id);
      assert.ok(ids.includes('signer-upstream-duplicate-key-rejection'),
        'top-level duplicate-key vector MUST exist by id');
      assert.ok(ids.includes('signer-upstream-duplicate-key-deep-nested'),
        'plain-nested duplicate-key vector MUST exist by id');
      assert.ok(ids.includes('signer-upstream-duplicate-key-array-contained'),
        'array-contained duplicate-key vector MUST exist by id — real-world AdCP payloads put state-change fields inside array-contained objects (packages[], creative_assets[], events[]); a signer that does not descend into array members ships the attack surface the rule targets');
      assert.ok(ids.includes('signer-upstream-duplicate-key-three-deep'),
        'three-deep duplicate-key vector MUST exist by id — hand-rolled recursive walkers with shallow depth bounds ship silently without this vector');
    });

    it('positive_vectors covers at least one clean-input case', () => {
      assert.ok(data.signer_side.positive_vectors.length >= 1,
        'positive_vectors MUST have at least one clean-input case — without it, a signer that rejects every input trivially passes the rejection vectors');
      const clean = data.signer_side.positive_vectors.find(v => v.id === 'signer-upstream-clean-input');
      assert.ok(clean, 'signer-upstream-clean-input fixture MUST exist by id');
      assert.equal(clean.expected_signer_action, 'sign-and-emit',
        'clean-input fixture MUST have expected_signer_action "sign-and-emit"');
    });

    it('signer_side.action_values defines both reject-input-before-sign and sign-and-emit', () => {
      assert.ok(data.signer_side.action_values['reject-input-before-sign'],
        'action_values["reject-input-before-sign"] MUST be defined — the load-bearing negative action');
      assert.ok(data.signer_side.action_values['sign-and-emit'],
        'action_values["sign-and-emit"] MUST be defined — the positive-path action asserted by positive_vectors');
    });

    const allSignerVectors = [
      ...(data.signer_side?.rejection_vectors || []),
      ...(data.signer_side?.positive_vectors || []),
    ];

    for (const vector of allSignerVectors) {
      it(`well-formed signer-side vector: ${vector.id}`, () => {
        const enumKeys = Object.keys(data.signer_side?.action_values || {});
        assert.equal(typeof vector.id, 'string', 'signer-side vector MUST have a kebab-case id');
        assert.match(vector.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id "${vector.id}" MUST be kebab-case`);
        assert.equal(typeof vector.signer_input_body, 'string',
          `vector "${vector.id}": signer_input_body MUST be a string (the pre-serialized bytes the upstream caller passed to the signer — distinct from raw_body which is wire-facing)`);
        assert.ok(enumKeys.includes(vector.expected_signer_action),
          `vector "${vector.id}": expected_signer_action "${vector.expected_signer_action}" is not in signer_side.action_values enum [${enumKeys.join(', ')}]`);
      });
    }

    // Scope-aware duplicate-key detector. Walks the JSON string tracking `{` / `}` / `[` / `]`
    // nesting and the in-string state, collecting object-scope key names per scope. Returns
    // true if any object scope has a duplicate key name. This handles the two cases a flat
    // regex gets wrong: (1) the same key name appearing in distinct array-contained objects
    // (legitimate — different scopes), (2) a string value that contains literal `":` (not a
    // key at all). Not a general JSON parser — assumes fixture JSON is well-formed — but
    // correct for the shapes in this file.
    function hasDuplicateKeyInAnyObjectScope(jsonStr) {
      const scopeStack = []; // each entry: { type: 'object'|'array', keys?: Set<string> }
      let i = 0;
      while (i < jsonStr.length) {
        const c = jsonStr[i];
        if (c === '{') { scopeStack.push({ type: 'object', keys: new Set() }); i++; continue; }
        if (c === '[') { scopeStack.push({ type: 'array' }); i++; continue; }
        if (c === '}' || c === ']') { scopeStack.pop(); i++; continue; }
        if (c === '"') {
          // Read string from i+1 to the closing quote, handling backslash escapes.
          let j = i + 1;
          let value = '';
          while (j < jsonStr.length) {
            if (jsonStr[j] === '\\' && j + 1 < jsonStr.length) { value += jsonStr[j + 1]; j += 2; continue; }
            if (jsonStr[j] === '"') break;
            value += jsonStr[j]; j++;
          }
          // Now j points at the closing quote. Look for the next non-whitespace char.
          let k = j + 1;
          while (k < jsonStr.length && /\s/.test(jsonStr[k])) k++;
          const isKey = jsonStr[k] === ':' && scopeStack.length > 0 && scopeStack[scopeStack.length - 1].type === 'object';
          if (isKey) {
            const scope = scopeStack[scopeStack.length - 1];
            if (scope.keys.has(value)) return true;
            scope.keys.add(value);
          }
          i = j + 1;
          continue;
        }
        i++;
      }
      return false;
    }

    it('duplicate-keys signer rejection vectors actually contain duplicate keys in at least one object scope', () => {
      for (const vector of data.signer_side?.rejection_vectors || []) {
        if (!/duplicate/.test(vector.id)) continue;
        assert.ok(hasDuplicateKeyInAnyObjectScope(vector.signer_input_body),
          `vector "${vector.id}": signer_input_body MUST contain a duplicate object key in at least one object scope — otherwise the fixture does not probe the rule it claims to probe`);
      }
    });

    it('clean-input positive vector does NOT contain duplicate keys at any object scope', () => {
      const clean = data.signer_side?.positive_vectors?.find(v => v.id === 'signer-upstream-clean-input');
      if (!clean) return;
      assert.ok(!hasDuplicateKeyInAnyObjectScope(clean.signer_input_body),
        `clean-input fixture MUST NOT contain duplicate keys at any object scope — otherwise the "positive case" is actually a negative case and the fixture does not assert what it claims`);
    });
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
