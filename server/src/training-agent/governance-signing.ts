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
 * Ephemeral per process — the kid changes across restarts. Same call-out
 * as the webhook-signing key: KMS-backed keys are the production answer
 * but the sandbox runs on the ephemeral keypair until cert-track KMS
 * provisioning lands.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-governance-signing');

const ADCP_USE = 'governance-signing';
const KID_PREFIX = 'training-gov-';

interface GovernanceSigningMaterial {
  /** Stable identifier published in the JWKS and the JWS header. */
  kid: string;
  /** Node KeyObject suitable for `jose.SignJWT`. Held in process memory only. */
  privateKey: KeyObject;
  /** Public JWK published on the aggregated brand.json. */
  publicJwk: AdcpJsonWebKey;
}

let material: GovernanceSigningMaterial | null = null;

function generateEphemeral(): GovernanceSigningMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
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
  material = generateEphemeral();
  logger.warn(
    { kid: material.kid },
    'Governance signing key generated ephemerally. Provision KMS-backed governance keys for stable kids.',
  );
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
