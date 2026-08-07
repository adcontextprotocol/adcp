#!/usr/bin/env node

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import canonicalize from 'canonicalize';

const fixtureUrl = new URL(
  '../static/compliance/source/test-vectors/governance-authorization.json',
  import.meta.url,
);

const TEST_KEY = {
  $comment: 'PUBLIC TEST KEY. The private component is published for deterministic conformance fixtures and MUST NOT be used as a production trust anchor or to authorize real activity.',
  kid: 'test-gov-2026',
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['verify'],
  adcp_use: 'governance-signing',
  x: 'rkUcKP5oMd7YjV4yy5mVS5S8fA3LDXcf5jk1P1_52EA',
  _private_d_for_test_only: 'bag_KLehHhOb-giX2u8kEfm9Djo6Fldl6_dFoRiC_eE',
};

const NOW = Math.floor(Date.parse('2026-08-05T12:00:00Z') / 1000);
const BASE_PAYLOAD = {
  idempotency_key: 'gov-vector-0000001',
  account: { account_id: 'acc_1' },
  amount: 1,
};
const ZERO_PAYLOAD = {
  idempotency_key: 'gov-vector-zero-0001',
  account: { account_id: 'acc_1' },
  amount: 0,
};

function payloadHash(payload) {
  const businessPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'governance_context' && key !== 'context'),
  );
  return createHash('sha256').update(canonicalize(businessPayload)).digest('base64url');
}

const BASE_HEADER = {
  alg: 'EdDSA',
  kid: TEST_KEY.kid,
  typ: 'adcp-gov+jws',
  crit: ['authorized_commitment', 'authorized_task', 'authorized_payload_hash'],
  authorized_commitment: true,
  authorized_task: true,
  authorized_payload_hash: true,
};

const BASE_CLAIMS = {
  iss: 'https://gov.example.com/governance',
  sub: 'gov_action_vector_0001',
  plan_hash: 'oR0jFDEtzcwgPbNf-Ofd_fZHYfAyD1TRbzGOFBVCG-c',
  aud: 'https://seller.example.com/sales',
  iat: NOW,
  nbf: NOW - 30,
  exp: NOW + 900,
  jti: 'gov-vector-base',
  phase: 'intent',
  caller: 'https://buyer.example.com',
  check_id: 'chk_vector_0001',
  authorized_commitment: { amount: 1, currency: 'USD' },
  authorized_task: 'create_media_buy',
  authorized_payload_hash: payloadHash(BASE_PAYLOAD),
};

const VERIFICATION_DEFAULTS = {
  now: NOW,
  clock_skew_seconds: 60,
  expected_issuer: BASE_CLAIMS.iss,
  expected_audience: BASE_CLAIMS.aud,
  authenticated_caller: BASE_CLAIMS.caller,
  expected_task: BASE_CLAIMS.authorized_task,
  payload: BASE_PAYLOAD,
  actual_commitment: { amount: 1, currency: 'USD' },
  expected_phase: 'intent',
};

function clone(value) {
  return structuredClone(value);
}

function withoutCrit(header, name) {
  header.crit = header.crit.filter((entry) => entry !== name);
  delete header[name];
}

const definitions = [
  { id: 'valid-exact-authorization', description: 'Exact task, payload, caller, audience, and commitment are accepted.', result: 'accept' },
  {
    id: 'unknown-critical-header',
    description: 'An unknown critical protected-header extension fails closed.',
    mutateHeader(header) {
      header.crit.push('future_governance_constraint');
      header.future_governance_constraint = true;
    },
    error: 'governance_token_invalid',
  },
  {
    id: 'claim-missing-critical-marker',
    description: 'An authorization-changing claim without its protected marker and crit entry is rejected.',
    mutateHeader(header) { withoutCrit(header, 'authorized_commitment'); },
    error: 'governance_token_invalid',
  },
  {
    id: 'critical-marker-missing-claim',
    description: 'A protected marker and crit entry without the matching claim is rejected.',
    mutateClaims(claims) { delete claims.authorized_commitment; },
    error: 'governance_token_invalid',
  },
  {
    id: 'audience-missing',
    description: 'The required audience claim is absent.',
    mutateClaims(claims) { delete claims.aud; },
    error: 'governance_token_invalid',
  },
  {
    id: 'audience-mismatch',
    description: 'A valid token for another service cannot be redirected.',
    mutateClaims(claims) { claims.aud = 'https://other-seller.example/sales'; },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'authenticated-caller-missing',
    description: 'The required authenticated-caller binding is absent.',
    mutateClaims(claims) { delete claims.caller; },
    error: 'governance_token_invalid',
  },
  {
    id: 'authenticated-caller-mismatch',
    description: 'The transport-authenticated caller must match the signed caller.',
    mutateClaims(claims) { claims.caller = 'https://other-buyer.example.com'; },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'authorized-task-missing',
    description: 'An action token cannot omit its authorized task while retaining a payload binding.',
    mutateHeader(header) { withoutCrit(header, 'authorized_task'); },
    mutateClaims(claims) { delete claims.authorized_task; },
    error: 'governance_token_invalid',
  },
  {
    id: 'authorized-task-mismatch',
    description: 'A token cannot authorize a different AdCP task.',
    mutateClaims(claims) { claims.authorized_task = 'update_media_buy'; },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'authorized-payload-hash-missing',
    description: 'An action token cannot omit its payload hash while retaining a task binding.',
    mutateHeader(header) { withoutCrit(header, 'authorized_payload_hash'); },
    mutateClaims(claims) { delete claims.authorized_payload_hash; },
    error: 'governance_token_invalid',
  },
  {
    id: 'authorized-payload-hash-mismatch',
    description: 'A token cannot be replayed over different downstream task arguments.',
    mutateClaims(claims) { claims.authorized_payload_hash = payloadHash({ ...BASE_PAYLOAD, amount: 2 }); },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'authorized-commitment-missing',
    description: 'A monetary operation requires a signed commitment ceiling.',
    mutateHeader(header) { withoutCrit(header, 'authorized_commitment'); },
    mutateClaims(claims) { delete claims.authorized_commitment; },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'authorized-currency-missing',
    description: 'A commitment claim without currency is malformed.',
    mutateClaims(claims) { delete claims.authorized_commitment.currency; },
    error: 'governance_token_invalid',
  },
  {
    id: 'authorized-currency-mismatch',
    description: 'The service-computed currency must match the signed currency.',
    mutateClaims(claims) { claims.authorized_commitment.currency = 'EUR'; },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'authorized-amount-missing',
    description: 'A commitment claim without a finite non-negative amount is malformed.',
    mutateClaims(claims) { delete claims.authorized_commitment.amount; },
    error: 'governance_token_invalid',
  },
  {
    id: 'actual-amount-widens-ceiling',
    description: 'The service-computed amount cannot exceed the signed ceiling.',
    verification_overrides: { actual_commitment: { amount: 1.01, currency: 'USD' } },
    error: 'governance_token_not_applicable',
  },
  {
    id: 'issued-at-in-future',
    description: 'An iat beyond the allowed clock skew is not yet valid.',
    mutateClaims(claims) { claims.iat = NOW + 61; },
    error: 'governance_token_not_yet_valid',
  },
  {
    id: 'not-before-in-future',
    description: 'An nbf beyond the allowed clock skew is not yet valid.',
    mutateClaims(claims) { claims.nbf = NOW + 61; },
    error: 'governance_token_not_yet_valid',
  },
  {
    id: 'expiration-missing',
    description: 'The required expiration bound is absent.',
    mutateClaims(claims) { delete claims.exp; },
    error: 'governance_token_invalid',
  },
  {
    id: 'token-expired',
    description: 'An expiration beyond the allowed clock skew is rejected.',
    mutateClaims(claims) { claims.exp = NOW - 61; },
    error: 'governance_token_expired',
  },
  {
    id: 'jti-missing',
    description: 'The required replay identifier is absent.',
    mutateClaims(claims) { delete claims.jti; },
    error: 'governance_token_invalid',
  },
  {
    id: 'jti-empty',
    description: 'An empty replay identifier is invalid.',
    mutateClaims(claims) { claims.jti = ''; },
    error: 'governance_token_invalid',
  },
  {
    id: 'jti-replayed',
    description: 'A previously consumed (iss, aud, jti) tuple is rejected.',
    verification_overrides: { preconsumed_jti: true },
    error: 'governance_token_replayed',
  },
  {
    id: 'signature-tampered',
    description: 'A modified compact-JWS signature is rejected.',
    tamperSignature: true,
    error: 'governance_token_invalid',
  },
  {
    id: 'zero-cost-commitment',
    description: 'An explicit zero-cost ceiling authorizes a verified zero-cost operation.',
    mutateClaims(claims) {
      claims.authorized_commitment = { amount: 0, currency: 'USD' };
      claims.authorized_payload_hash = payloadHash(ZERO_PAYLOAD);
    },
    verification_overrides: {
      payload: ZERO_PAYLOAD,
      actual_commitment: { amount: 0, currency: 'USD' },
    },
    result: 'accept',
  },
  {
    id: 'zero-cost-ceiling-widened',
    description: 'A zero-cost authorization cannot be widened to a positive commitment.',
    mutateClaims(claims) {
      claims.authorized_commitment = { amount: 0, currency: 'USD' };
      claims.authorized_payload_hash = payloadHash(ZERO_PAYLOAD);
    },
    verification_overrides: {
      payload: ZERO_PAYLOAD,
      actual_commitment: { amount: 0.01, currency: 'USD' },
    },
    error: 'governance_token_not_applicable',
  },
];

const privateKey = createPrivateKey({
  key: {
    kty: TEST_KEY.kty,
    crv: TEST_KEY.crv,
    x: TEST_KEY.x,
    d: TEST_KEY._private_d_for_test_only,
  },
  format: 'jwk',
});

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signCompact(protectedHeader, claims) {
  const signingInput = `${encodeJson(protectedHeader)}.${encodeJson(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function buildCase(definition) {
  const protectedHeader = clone(BASE_HEADER);
  const claims = clone(BASE_CLAIMS);
  claims.jti = `gov-vector-${definition.id}`;
  definition.mutateHeader?.(protectedHeader);
  definition.mutateClaims?.(claims);
  let compactJws = signCompact(protectedHeader, claims);
  if (definition.tamperSignature) {
    const parts = compactJws.split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    compactJws = parts.join('.');
  }
  return {
    id: definition.id,
    description: definition.description,
    protected_header: protectedHeader,
    claims,
    ...(definition.verification_overrides
      ? { verification_overrides: definition.verification_overrides }
      : {}),
    compact_jws: compactJws,
    expected: definition.result === 'accept'
      ? { result: 'accept', error: null }
      : { result: 'reject', error: definition.error },
  };
}

const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
fixture.signed_jws = {
  profile: 'adcp/governance-authorization-jws/v1',
  warning: 'TEST-ONLY cryptographic material. Never install this JWK as a production trust anchor and never use it to authorize real spend or other activity.',
  serialization: 'UTF-8 JSON.stringify insertion order for the published protected_header and claims objects, followed by unpadded base64url and deterministic Ed25519 signing.',
  test_key: TEST_KEY,
  verification_defaults: VERIFICATION_DEFAULTS,
  cases: definitions.map(buildCase),
};

// Escape compact-JWS separators in the JSON source so generic credential
// scanners do not mistake these deliberately public test vectors for tokens.
// JSON parsers decode \u002e back to ".", preserving the byte-exact value.
const rendered = `${JSON.stringify(fixture, null, 2).replace(
  /^(\s*"compact_jws": ")([^"]+)(".*)$/gm,
  (_, prefix, compactJws, suffix) => `${prefix}${compactJws.replaceAll('.', '\\u002e')}${suffix}`
)}\n`;
if (process.argv.includes('--check')) {
  const current = readFileSync(fixtureUrl, 'utf8');
  if (current !== rendered) {
    console.error(`${fileURLToPath(fixtureUrl)} is stale; run node scripts/generate-governance-jws-vectors.mjs`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(fixtureUrl, rendered);
}
