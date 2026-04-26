/**
 * Public JWKS for Addie's signing keys.
 *
 * Two entries — one per AdCP signing purpose. AdCP receivers enforce key
 * purpose at the JWK's `adcp_use` field (`docs/guides/SIGNING-GUIDE.md` §
 * Key separation), so request-signing and webhook-signing keys must
 * appear as distinct JWK entries with their respective `adcp_use` values.
 *
 * Both derived from the committed PEM constants so the published JWKS
 * and each signer's tripwire reference the same source of truth —
 * rotation is a one-line edit to `expected-public-key.ts` plus a
 * `GCP_KMS_*_KEY_VERSION` secret update.
 */

import { createPublicKey } from 'node:crypto';
import {
  REQUEST_SIGNING_PUBLIC_KEY_PEM,
  REQUEST_SIGNING_KID,
  WEBHOOK_SIGNING_PUBLIC_KEY_PEM,
  WEBHOOK_SIGNING_KID,
} from './expected-public-key.js';

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
  cached = {
    keys: [
      pemToAdcpJwk(REQUEST_SIGNING_PUBLIC_KEY_PEM, REQUEST_SIGNING_KID, 'request-signing'),
      pemToAdcpJwk(WEBHOOK_SIGNING_PUBLIC_KEY_PEM, WEBHOOK_SIGNING_KID, 'webhook-signing'),
    ],
  };
  return cached;
}

function pemToAdcpJwk(pem: string, kid: string, adcpUse: 'request-signing' | 'webhook-signing'): PublicJwk {
  const raw = createPublicKey(pem).export({ format: 'jwk' }) as {
    kty?: string;
    crv?: string;
    x?: string;
  };
  if (raw.kty !== 'OKP' || raw.crv !== 'Ed25519' || typeof raw.x !== 'string') {
    throw new Error(
      `Expected public key for ${adcpUse} is not Ed25519 OKP (got kty=${raw.kty}, crv=${raw.crv}). ` +
        'Update expected-public-key.ts.'
    );
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: raw.x,
    kid,
    alg: 'EdDSA',
    use: 'sig',
    adcp_use: adcpUse,
    key_ops: ['verify'],
  };
}

export function resetJwksForTests(): void {
  cached = null;
}
