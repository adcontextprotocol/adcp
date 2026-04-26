/**
 * Public JWKS for Addie's request-signing key.
 *
 * Derived from the committed `EXPECTED_PUBLIC_KEY_PEM` so the published key
 * and the signer's tripwire always reference the same source of truth —
 * rotation is a one-line edit to that file plus a `GCP_KMS_KEY_VERSION`
 * secret update.
 */

import { createPublicKey } from 'node:crypto';
import { EXPECTED_PUBLIC_KEY_PEM } from './expected-public-key.js';
import { KID } from './gcp-kms-signer.js';

interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  alg: string;
  use: string;
  adcp_use: string;
  key_ops: string[];
}

let cached: { keys: PublicJwk[] } | null = null;

export function getPublicSigningJwks(): { keys: PublicJwk[] } {
  if (cached) return cached;
  const raw = createPublicKey(EXPECTED_PUBLIC_KEY_PEM).export({ format: 'jwk' }) as {
    kty?: string;
    crv?: string;
    x?: string;
  };
  if (raw.kty !== 'OKP' || raw.crv !== 'Ed25519' || typeof raw.x !== 'string') {
    throw new Error(
      `Expected public key is not Ed25519 OKP (got kty=${raw.kty}, crv=${raw.crv}). ` +
        'Update expected-public-key.ts.'
    );
  }
  const jwk: PublicJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: raw.x,
    kid: KID,
    alg: 'EdDSA',
    use: 'sig',
    adcp_use: 'request-signing',
    key_ops: ['verify'],
  };
  cached = { keys: [jwk] };
  return cached;
}

export function resetJwksForTests(): void {
  cached = null;
}
