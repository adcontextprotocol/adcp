const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const vectorsDir = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'test-vectors',
  'webhook-signing',
);

const keys = JSON.parse(fs.readFileSync(path.join(vectorsDir, 'keys.json'), 'utf8')).keys;
const keysByKid = new Map(keys.map((key) => [key.kid, key]));

function readVector(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(vectorsDir, relativePath), 'utf8'));
}

function extractSig1Signature(vector) {
  const signature = vector.request?.headers?.Signature;
  assert.equal(typeof signature, 'string', `${vector.name}: Signature header must be present`);
  const match = signature.match(/^sig1=:([A-Za-z0-9+/_=-]+):$/);
  assert.ok(match, `${vector.name}: Signature header must contain a sig1 sf-binary value`);
  return Buffer.from(match[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyVectorSignature(vector, relativePath) {
  assert.equal(vector.jwks_ref?.length, 1, `${relativePath}: expected exactly one jwks_ref kid`);
  const [kid] = vector.jwks_ref;
  const jwk = keysByKid.get(kid);
  assert.ok(jwk, `${relativePath}: jwks_ref kid ${kid} missing from keys.json`);
  assert.ok(
    vector.expected_signature_base.includes(`keyid="${kid}"`),
    `${relativePath}: expected_signature_base must bind jwks_ref kid ${kid}`,
  );

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signature = extractSig1Signature(vector);
  const signatureBase = Buffer.from(vector.expected_signature_base, 'utf8');

  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    assert.equal(signature.length, 64, `${relativePath}: Ed25519 signatures must be 64 bytes`);
    assert.equal(
      crypto.verify(null, signatureBase, publicKey, signature),
      true,
      `${relativePath}: Ed25519 signature must verify against ${kid}`,
    );
    return;
  }

  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    assert.equal(signature.length, 64, `${relativePath}: ES256 signatures must use IEEE P1363 r||s encoding`);
    assert.equal(
      crypto.verify('sha256', signatureBase, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature),
      true,
      `${relativePath}: ES256 signature must verify against ${kid}`,
    );
    return;
  }

  throw new Error(`${relativePath}: unsupported test key ${kid} (${jwk.kty}/${jwk.crv})`);
}

describe('RFC 9421 webhook-signing vectors', () => {
  const positiveFiles = fs
    .readdirSync(path.join(vectorsDir, 'positive'))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => `positive/${file}`);

  for (const relativePath of positiveFiles) {
    it(`cryptographically verifies ${relativePath}`, () => {
      const vector = readVector(relativePath);
      assert.equal(vector.expected_outcome?.success, true, `${relativePath}: must be a positive vector`);
      verifyVectorSignature(vector, relativePath);
    });
  }

  it('cryptographically verifies negative/008 before the verifier rejects at step 8', () => {
    const relativePath = 'negative/008-wrong-adcp-use.json';
    const vector = readVector(relativePath);
    assert.equal(vector.expected_outcome?.success, false);
    assert.equal(vector.expected_outcome?.failed_step, 8);
    assert.equal(vector.expected_outcome?.error_code, 'webhook_signature_key_purpose_invalid');
    assert.deepEqual(vector.jwks_ref, ['test-response-purpose-2026']);
    verifyVectorSignature(vector, relativePath);
  });
});
