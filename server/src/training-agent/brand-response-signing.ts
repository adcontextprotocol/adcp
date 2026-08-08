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
 * Replica-stable kid. Because this module teaches learners to fetch the JWKS and
 * verify a signed_response — two requests that can land on different replicas when
 * min_machines_running > 1 — the key is derived deterministically from the app-wide
 * shared secret so every replica mints the same kid (see ensureMaterial). The kid
 * still rotates if that secret rotates. KMS-backed keys with a stable kid remain
 * the production answer for all signing material (cert-track follow-up, shared with
 * the webhook- and governance-signing keys, which are still ephemeral per process).
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-brand-response-signing');

const ADCP_USE = 'response-signing';
const KID_PREFIX = 'training-brand-resp-';

// Ed25519 PKCS8 v1 DER prefix (RFC 8410): SEQUENCE, version 0, AlgorithmIdentifier
// for OID 1.3.101.112 (Ed25519), then an OCTET STRING wrapping the 32-byte seed.
// Concatenated with a 32-byte seed it forms a complete deterministic private key.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface BrandResponseSigningMaterial {
  /** Stable identifier published in the JWKS and the JWS protected header. */
  kid: string;
  /** Node KeyObject suitable for signing the envelope. Held in process memory only. */
  privateKey: KeyObject;
  /** Public JWK published on the aggregated JWKS. */
  publicJwk: AdcpJsonWebKey;
}

let material: BrandResponseSigningMaterial | null = null;

function buildMaterial(privateKey: KeyObject): BrandResponseSigningMaterial {
  // Node's JWK export for Ed25519 emits { kty: 'OKP', crv: 'Ed25519', x }.
  // Destructure explicitly so a future Node version that adds private bits to
  // the public-export shape can't accidentally leak into the published JWK.
  const { kty, crv, x } = createPublicKey(privateKey).export({ format: 'jwk' }) as {
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

  // Multi-replica safety. This module teaches learners to fetch /.well-known/jwks.json
  // AND call verify_brand_claim, then verify the signed_response against the JWKS.
  // The app runs with min_machines_running > 1, so those two requests can land on
  // different replicas. An ephemeral per-process key would then give each replica a
  // different kid, and a learner verifying a signed_response from replica A against
  // the JWKS from replica B would hit a kid mismatch — surfacing as a confusing
  // "valid signature won't verify", the exact failure this lab is meant to teach by
  // SUCCESS. So when the app-wide shared secret is present we DERIVE the key
  // deterministically from it (purpose-namespaced, distinct adcp_use/kid — not key
  // reuse), so every replica mints the same kid. KMS-backed keys with a stable kid
  // remain the production answer for all signing material (cert-track follow-up,
  // shared with the governance- and webhook-signing keys). Absent the secret (some
  // unit envs, single process) we fall back to an ephemeral key.
  const secret = process.env.AGENT_TOKEN_ENCRYPTION_SECRET;
  if (secret) {
    const seed = createHash('sha256').update(`adcp:brand-response-signing:v1:${secret}`).digest();
    const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
    material = buildMaterial(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
    return material;
  }

  material = buildMaterial(generateKeyPairSync('ed25519').privateKey);
  logger.warn(
    { kid: material.kid },
    'Brand response-signing key generated ephemerally (no AGENT_TOKEN_ENCRYPTION_SECRET); kid is per-process and will skew across replicas. Set the shared secret (or provision KMS) for a stable kid.',
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
