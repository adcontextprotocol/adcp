/**
 * Test-only keypairs for webhook-signature verifier unit tests.
 *
 * The public halves match entries in
 * static/compliance/source/test-vectors/request-signing/keys.json; we
 * duplicate them here (along with the private `d`) so the tests are
 * self-contained and don't depend on that compliance fixture layout.
 *
 * These keys are PUBLIC. They MUST NOT be used for production signing.
 */

export const TEST_ED25519_PUBLIC_JWK = {
  kid: 'test-ed25519-2026',
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['verify'],
  x: 'gWUqzATUcUco5Q8fZZXn8aWwb7DQbYGBiqUzLiSDDJo',
} as const;

export const TEST_ED25519_PRIVATE_JWK = {
  ...TEST_ED25519_PUBLIC_JWK,
  key_ops: ['sign'],
  d: 'A_rC9vrZ2D1xJWLBXGdRW7CYLAh_f83Gqv8nhly7N2M',
} as const;

export const TEST_JWKS = {
  keys: [TEST_ED25519_PUBLIC_JWK],
} as const;
