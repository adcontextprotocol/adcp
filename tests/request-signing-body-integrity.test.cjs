const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  evaluateBodyIntegrity,
  usesUniversalBodyIntegrity,
} = require('./helpers/reference-request-signing-body-integrity.cjs');

const fixturePath = path.join(
  __dirname,
  '../static/compliance/source/test-vectors/request-signing/body-integrity-policy.json'
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('AdCP 3.2 request-signing body-integrity policy', () => {
  it('pins the fixture to the 3.2 signing profile', () => {
    assert.equal(fixture.profile_version, '3.2');
  });

  for (const testCase of fixture.cases) {
    it(testCase.id, () => {
      assert.deepEqual(evaluateBodyIntegrity(testCase), testCase.expected);
    });
  }

  it('covers all six operation and protocol-method list modes', () => {
    const modes = new Set(fixture.cases.map(testCase => testCase.mode));
    assert.deepEqual(
      [...modes].sort(),
      [
        'protocol_methods_required_for',
        'protocol_methods_supported_for',
        'protocol_methods_warn_for',
        'required_for',
        'supported_for',
        'warn_for',
      ]
    );
  });

  it('applies the body-integrity profile to 3.2 prereleases and later releases', () => {
    for (const version of ['3.2-beta.1', '3.2', '3.3', '4.0', '10.0']) {
      assert.equal(usesUniversalBodyIntegrity(version), true, version);
    }
    for (const version of ['3.0', '3.1-rc.1', '3.1']) {
      assert.equal(usesUniversalBodyIntegrity(version), false, version);
    }
  });

  it('pins the root positive wire suite to the 3.1 encoding profile', () => {
    const positiveDir = path.join(path.dirname(fixturePath), 'positive');
    for (const file of fs.readdirSync(positiveDir).filter(name => name.endsWith('.json'))) {
      const vector = JSON.parse(fs.readFileSync(path.join(positiveDir, file), 'utf8'));
      assert.equal(vector.signing_profile_version, '3.1', file);
    }
  });

  it('cryptographically verifies the legacy 3.1 body-bound positive', () => {
    const baseDir = path.dirname(fixturePath);
    const vector = JSON.parse(fs.readFileSync(path.join(baseDir, 'positive/002-post-with-content-digest.json'), 'utf8'));
    const keys = JSON.parse(fs.readFileSync(path.join(baseDir, 'keys.json'), 'utf8'));
    const jwk = keys.keys.find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signature = vector.request.headers.Signature.match(/^sig1=:([^:]+):$/)?.[1];
    const digest = vector.request.headers['Content-Digest'].match(/^sha-256=:([^:]+):$/)?.[1];

    assert.equal(vector.signing_profile_version, '3.1');
    assert.match(signature, /[-_]/, 'legacy signature must use Base64URL');
    assert.doesNotMatch(digest, /[+/=]/, 'legacy digest must use unpadded Base64URL');
    assert.equal(crypto.createHash('sha256').update(vector.request.body).digest('base64url'), digest);
    assert.equal(
      crypto.verify(null, Buffer.from(vector.expected_signature_base), publicKey, Buffer.from(signature, 'base64url')),
      true
    );
  });

  it('pins the legacy negative wire suite to the 3.1 encoding profile', () => {
    const negativeDir = path.join(path.dirname(fixturePath), 'negative');
    for (const file of fs.readdirSync(negativeDir).filter(name => name.endsWith('.json'))) {
      const vector = JSON.parse(fs.readFileSync(path.join(negativeDir, file), 'utf8'));
      assert.equal(vector.signing_profile_version, '3.1', file);
    }
  });

  it('cryptographically verifies the 3.2 body-bearing positive vector', () => {
    const baseDir = path.dirname(fixturePath);
    const vector = JSON.parse(fs.readFileSync(
      path.join(baseDir, 'profile-3.2/positive/001-post-with-content-digest.json'),
      'utf8'
    ));
    const keys = JSON.parse(fs.readFileSync(path.join(baseDir, 'keys.json'), 'utf8'));
    const jwk = keys.keys.find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      format: 'jwk',
    });
    const signature = vector.request.headers.Signature.match(/^sig1=:([^:]+):$/)?.[1];
    assert.ok(signature, 'vector signature must use the sig1 structured-field label');
    assert.equal(vector.signing_profile_version, '3.2');
    assert.match(vector.request.headers['Signature-Input'], /"content-digest"/);
    const digest = vector.request.headers['Content-Digest'].match(/^sha-256=:([^:]+):$/)?.[1];
    assert.ok(digest, 'vector must carry a sha-256 Content-Digest');
    assert.doesNotMatch(digest, /[-_]/, 'sf-binary must use the standard Base64 alphabet');
    assert.equal(crypto.createHash('sha256').update(vector.request.body).digest('base64'), digest);
    assert.equal(
      crypto.verify(null, Buffer.from(vector.expected_signature_base), publicKey, Buffer.from(signature, 'base64')),
      true
    );
  });

  it('rejects a cryptographically valid legacy Base64URL Signature token in 3.2', () => {
    const baseDir = path.dirname(fixturePath);
    const vector = JSON.parse(fs.readFileSync(
      path.join(baseDir, 'profile-3.2/negative/001-base64url-sf-binary.json'),
      'utf8'
    ));
    const keys = JSON.parse(fs.readFileSync(path.join(baseDir, 'keys.json'), 'utf8'));
    const jwk = keys.keys.find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signature = vector.request.headers.Signature.match(/^sig1=:([^:]+):$/)?.[1];

    assert.equal(vector.signing_profile_version, '3.2');
    assert.match(signature, /[-_]/, 'negative must exercise the legacy Base64URL alphabet');
    assert.equal(vector.expected_outcome.error_code, 'request_signature_header_malformed');
    assert.equal(
      crypto.verify(null, Buffer.from(vector.expected_signature_base), publicKey, Buffer.from(signature, 'base64url')),
      true,
      'the raw signature must be valid so only sf-binary parsing causes rejection'
    );
  });
});
