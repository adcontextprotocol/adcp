/**
 * Governance-signing key material for the training agent.
 *
 * One Ed25519 keypair, used only to sign compact-JWS `governance_context`
 * tokens emitted by the governance tenant's `check_governance` handler. Spec:
 * docs/building/by-layer/L1/security.mdx §"AdCP JWS profile".
 *
 * Cross-purpose key reuse is forbidden by the profile: this key MUST NOT
 * appear under any other `adcp_use` value, and its `kid` MUST NOT collide
 * with the webhook-signing or transport-signing kids on the shared JWKS.
 *
 * Stable across restarts: the keypair is derived deterministically from a
 * fixed, non-secret sandbox label (SHA-256 → Ed25519 seed), so the `kid`
 * stays constant and always matches the public JWK published at
 * `/.well-known/jwks.json`. That stability is what lets a learner resolve a
 * `governance_context` token's `iss`→JWKS→`kid` and cryptographically verify
 * the signature (S6 cert lab). This is a PUBLIC SANDBOX signing key with no
 * security value — nothing here authorizes real spend. Production governance
 * agents MUST use KMS-backed keys; the derivation below is sandbox-only.
 *
 * Because the private key is fully reconstructable from public source (the
 * fixed label + known PKCS8 prefix + SHA-256), a valid signature under a
 * `training-gov-*` kid proves nothing about the signer's identity and MUST
 * NOT be treated as an authentication signal anywhere outside the sandbox lab.
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';

const ADCP_USE = 'governance-signing';
const KID_PREFIX = 'training-gov-';

// Fixed, non-secret label → deterministic Ed25519 seed. Derived (not a
// committed key) so it carries no secret material and won't trip secret
// scanners, while still yielding a stable keypair + kid every boot.
const SANDBOX_KEY_LABEL = 'adcp-training-agent:sandbox:governance-signing:v1';
// Ed25519 PKCS8 DER prefix for a raw 32-byte seed (RFC 8410 §7).
const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';

interface GovernanceSigningMaterial {
  /** Stable identifier published in the JWKS and the JWS header. */
  kid: string;
  /** Node KeyObject suitable for `jose.SignJWT`. Held in process memory only. */
  privateKey: KeyObject;
  /** Public JWK published on the aggregated brand.json. */
  publicJwk: AdcpJsonWebKey;
}

let material: GovernanceSigningMaterial | null = null;

function deriveStableMaterial(): GovernanceSigningMaterial {
  const seed = createHash('sha256').update(SANDBOX_KEY_LABEL).digest(); // 32 bytes
  const pkcs8 = Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  // Node's JWK export for Ed25519 emits { kty: 'OKP', crv: 'Ed25519', x }.
  // Destructure explicitly so a future Node version that adds private bits
  // to the public-export shape can't accidentally leak into the published JWK.
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

function ensureMaterial(): GovernanceSigningMaterial {
  if (material) return material;
  material = deriveStableMaterial();
  return material;
}

/** Public JWK for inclusion in the aggregated brand.json JWKS. */
export function getGovernanceSigningPublicJwk(): AdcpJsonWebKey {
  return ensureMaterial().publicJwk;
}

/** Kid + private key for signing JWS tokens. Never exposed off-process. */
export function getGovernanceSigningKey(): { kid: string; privateKey: KeyObject } {
  const m = ensureMaterial();
  return { kid: m.kid, privateKey: m.privateKey };
}

/** Reset state — tests only. */
export function resetGovernanceSigning(): void {
  material = null;
}
