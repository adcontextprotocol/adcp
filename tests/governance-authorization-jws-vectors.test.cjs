const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('@adcp/sdk');

const fixturePath = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'test-vectors',
  'governance-authorization.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const vectors = fixture.signed_jws;

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signingInput(vector) {
  return `${encodeJson(vector.protected_header)}.${encodeJson(vector.claims)}`;
}

function publicKeyFromFixture() {
  const key = vectors.test_key;
  return createPublicKey({
    key: { kty: key.kty, crv: key.crv, x: key.x },
    format: 'jwk',
  });
}

function privateKeyFromFixture() {
  const key = vectors.test_key;
  return createPrivateKey({
    key: {
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      d: key._private_d_for_test_only,
    },
    format: 'jwk',
  });
}

function reject(error) {
  return { result: 'reject', error };
}

function evaluate(vector, signatureValid) {
  const header = vector.protected_header;
  const claims = vector.claims;
  const input = {
    ...vectors.verification_defaults,
    ...(vector.verification_overrides || {}),
  };
  const recognizedCritical = [
    'authorized_commitment',
    'authorized_task',
    'authorized_payload_hash',
  ];

  if (header.alg !== 'EdDSA' || header.typ !== 'adcp-gov+jws') {
    return reject('governance_token_invalid');
  }
  if (!Array.isArray(header.crit)) return reject('governance_token_invalid');
  if (header.crit.some((name) => !recognizedCritical.includes(name))) {
    return reject('governance_token_invalid');
  }
  for (const name of recognizedCritical) {
    const hasClaim = claims[name] !== undefined;
    const hasMarker = header.crit.includes(name) && header[name] === true;
    if (hasClaim !== hasMarker) return reject('governance_token_invalid');
  }
  if ((claims.authorized_task === undefined) !== (claims.authorized_payload_hash === undefined)) {
    return reject('governance_token_invalid');
  }
  if (!signatureValid) return reject('governance_token_invalid');
  if (typeof claims.iss !== 'string' || !claims.iss) return reject('governance_token_invalid');
  if (claims.iss !== input.expected_issuer) return reject('governance_issuer_not_authorized');
  if (typeof claims.aud !== 'string' || !claims.aud) return reject('governance_token_invalid');
  if (typeof claims.caller !== 'string' || !claims.caller) return reject('governance_token_invalid');
  if (typeof claims.sub !== 'string' || !claims.sub) return reject('governance_token_invalid');
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    return reject('governance_token_invalid');
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return reject('governance_token_invalid');
  }
  if (typeof claims.jti !== 'string' || !claims.jti) return reject('governance_token_invalid');
  if (claims.authorized_commitment !== undefined) {
    const commitment = claims.authorized_commitment;
    if (
      !commitment
      || typeof commitment !== 'object'
      || Array.isArray(commitment)
      || typeof commitment.amount !== 'number'
      || !Number.isFinite(commitment.amount)
      || commitment.amount < 0
      || typeof commitment.currency !== 'string'
      || !commitment.currency
    ) {
      return reject('governance_token_invalid');
    }
  }

  if (claims.iat > input.now + input.clock_skew_seconds) {
    return reject('governance_token_not_yet_valid');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > input.now + input.clock_skew_seconds) {
    return reject('governance_token_not_yet_valid');
  }
  if (claims.exp < input.now - input.clock_skew_seconds) {
    return reject('governance_token_expired');
  }
  if (
    claims.aud !== input.expected_audience
    || claims.caller !== input.authenticated_caller
    || claims.phase !== input.expected_phase
  ) {
    return reject('governance_token_not_applicable');
  }
  if (
    claims.authorized_task === undefined
    || claims.authorized_payload_hash === undefined
  ) {
    return reject('governance_token_invalid');
  }
  const businessPayload = Object.fromEntries(
    Object.entries(input.payload).filter(([key]) => key !== 'governance_context' && key !== 'context'),
  );
  const expectedHash = createHash('sha256')
    .update(canonicalize(businessPayload))
    .digest('base64url');
  if (
    claims.authorized_task !== input.expected_task
    || claims.authorized_payload_hash !== expectedHash
  ) {
    return reject('governance_token_not_applicable');
  }
  if (claims.authorized_commitment === undefined) {
    return reject('governance_token_not_applicable');
  }
  if (
    claims.authorized_commitment.currency !== input.actual_commitment.currency
    || input.actual_commitment.amount > claims.authorized_commitment.amount
  ) {
    return reject('governance_token_not_applicable');
  }
  if (vector.verification_overrides?.preconsumed_jti) {
    return reject('governance_token_replayed');
  }
  return { result: 'accept', error: null };
}

test('governance signed-JWS vectors are deterministic and match their expected decisions', () => {
  assert.equal(vectors.profile, 'adcp/governance-authorization-jws/v1');
  assert.match(vectors.warning, /TEST-ONLY/);
  assert.match(vectors.test_key.$comment, /MUST NOT/);
  assert.equal(vectors.test_key.adcp_use, 'governance-signing');
  assert.deepEqual(vectors.test_key.key_ops, ['verify']);
  assert.ok(vectors.cases.length >= 20);
  assert.equal(new Set(vectors.cases.map((vector) => vector.id)).size, vectors.cases.length);

  const privateKey = privateKeyFromFixture();
  const publicKey = publicKeyFromFixture();
  for (const vector of vectors.cases) {
    const input = signingInput(vector);
    const expectedSignature = sign(null, Buffer.from(input), privateKey).toString('base64url');
    const expectedCompact = `${input}.${expectedSignature}`;
    const parts = vector.compact_jws.split('.');
    assert.equal(parts.length, 3, vector.id);
    assert.ok(vector.compact_jws.length <= 4096, `${vector.id} exceeds the governance_context envelope limit`);
    assert.equal(`${parts[0]}.${parts[1]}`, input, vector.id);

    const signatureValid = verify(
      null,
      Buffer.from(input),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    if (vector.id === 'signature-tampered') {
      assert.notEqual(vector.compact_jws, expectedCompact, vector.id);
      assert.equal(signatureValid, false, vector.id);
    } else {
      assert.equal(vector.compact_jws, expectedCompact, vector.id);
      assert.equal(signatureValid, true, vector.id);
    }
    assert.deepEqual(evaluate(vector, signatureValid), vector.expected, vector.id);
  }
});
