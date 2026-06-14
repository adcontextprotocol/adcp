/**
 * Brand response-signing key material for the training agent.
 *
 * One Ed25519 keypair, used only to sign the payload-envelope JWS that rides
 * inside `verify_brand_claim` / `verify_brand_claims` responses. Spec:
 * docs/brand-protocol/tasks/verify_brand_claim.mdx §"Trust model" and
 * static/schemas/source/core/response-payload-jws-envelope.json.
 *
 * This is the closed designated-task response-signing profile — a JWS whose
 * payload is the RFC 8785/JCS canonicalization of the envelope object, distinct
 * from RFC 9421 transport response signing. Verifiers enforce the key purpose by
 * resolving `kid` to a JWK with `adcp_use: response-signing`.
 *
 * Cross-purpose key reuse is forbidden by the profile: this key MUST NOT appear
 * under any other `adcp_use` value, and its `kid` MUST NOT collide with the
 * webhook-signing or governance-signing kids on the shared JWKS.
 *
 * Ephemeral per process — the kid changes across restarts. Same call-out as the
 * webhook-signing and governance-signing keys: KMS-backed keys are the
 * production answer but the sandbox runs on the ephemeral keypair until
 * cert-track KMS provisioning lands.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-brand-response-signing');

const ADCP_USE = 'response-signing';
const KID_PREFIX = 'training-brand-resp-';

interface BrandResponseSigningMaterial {
  /** Stable identifier published in the JWKS and the JWS protected header. */
  kid: string;
  /** Node KeyObject suitable for signing the envelope. Held in process memory only. */
  privateKey: KeyObject;
  /** Public JWK published on the aggregated JWKS. */
  publicJwk: AdcpJsonWebKey;
}

let material: BrandResponseSigningMaterial | null = null;

function generateEphemeral(): BrandResponseSigningMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Node's JWK export for Ed25519 emits { kty: 'OKP', crv: 'Ed25519', x }.
  // Destructure explicitly so a future Node version that adds private bits to
  // the public-export shape can't accidentally leak into the published JWK.
  const { kty, crv, x } = publicKey.export({ format: 'jwk' }) as {
    kty: 'OKP'; crv: 'Ed25519'; x: string;
  };
  const kid = `${KID_PREFIX}${createHash('sha256').update(x).digest('hex').slice(0, 16)}`;
  const publicJwk: AdcpJsonWebKey = {
    kty,
    crv,
    x,
    kid,
    alg: 'EdDSA',
    adcp_use: ADCP_USE,
    key_ops: ['verify'],
    use: 'sig',
  };
  return { kid, privateKey, publicJwk };
}

function ensureMaterial(): BrandResponseSigningMaterial {
  if (material) return material;
  material = generateEphemeral();
  logger.warn(
    { kid: material.kid },
    'Brand response-signing key generated ephemerally. Provision KMS-backed response-signing keys for stable kids.',
  );
  return material;
}

/** Public JWK for inclusion in the aggregated JWKS. */
export function getBrandResponseSigningPublicJwk(): AdcpJsonWebKey {
  return ensureMaterial().publicJwk;
}

/** Kid + private key for signing envelopes. Never exposed off-process. */
export function getBrandResponseSigningKey(): { kid: string; privateKey: KeyObject } {
  const m = ensureMaterial();
  return { kid: m.kid, privateKey: m.privateKey };
}

/** Reset state — tests only. */
export function resetBrandResponseSigning(): void {
  material = null;
}
