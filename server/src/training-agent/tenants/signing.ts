/**
 * Per-tenant signing material.
 *
 * Each tenant has its own Ed25519 keypair and KID. Public keys aggregate
 * into a shared `/.well-known/brand.json` at the host root — RFC 5785
 * well-known URIs are origin-scoped, so path-based tenants on one host
 * share the discovery file. The SDK's TenantRegistry default JWKS
 * validator fetches `new URL('/.well-known/brand.json', agentUrl)` which
 * resolves to host root regardless of the tenant's path prefix.
 *
 * Production: per-tenant GCP KMS keys (env vars
 * `GCP_KMS_WEBHOOK_KEY_VERSION_${TENANT_ID}`). Until KMS keys are
 * provisioned, ephemeral per-tenant keys generated at boot. KIDs change
 * across restarts — fine for the sandbox, AAO certification waits for
 * KMS-backed keys.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { TenantSigningKey } from '@adcp/sdk/server';
import type { AdcpJsonWebKey, SignerKey } from '@adcp/sdk/signing';
import { createLogger } from '../../logger.js';
import { getGovernanceSigningPublicJwk } from '../governance-signing.js';

const logger = createLogger('training-agent-tenant-signing');

interface TenantMaterial {
  signingKey: TenantSigningKey;
  publicJwk: AdcpJsonWebKey;
}

/** Response-signing material is distinct from webhook-signing material per
 *  the `adcp_use` distinct-keys-per-purpose invariant — the SDK's
 *  `signResponse` verifies that the supplied key carries
 *  `adcp_use: "response-signing"` before signing. */
interface TenantResponseSigningMaterial {
  signerKey: SignerKey;
  publicJwk: AdcpJsonWebKey;
}

const materials: Map<string, TenantMaterial> = new Map();
const responseSigningMaterials: Map<string, TenantResponseSigningMaterial> = new Map();

/**
 * Generate an ephemeral Ed25519 keypair for a tenant. KID = `training-${tenantId}-${random}`.
 * Stable for the process lifetime; regenerates on restart.
 */
function generateEphemeralKey(tenantId: string): TenantMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // node:crypto JWK export is plain Record<string, unknown>; use a permissive
  // shape that satisfies both AdcpJsonWebKey and TenantSigningKey's
  // JsonWebKey expectation.
  const privateJwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = `training-${tenantId}-${randomBytes(4).toString('hex')}`;

  const signingKey: TenantSigningKey = {
    keyId: kid,
    publicJwk: { ...publicJwk, kid },
    privateJwk: { ...privateJwk, kid },
  };

  // brand.json's jwks.keys[] entries are AdcpJsonWebKey shape — adcp_use,
  // key_ops, alg, use are all required by the SDK validator.
  const brandJwk: AdcpJsonWebKey = {
    ...publicJwk,
    kid,
    alg: 'EdDSA',
    adcp_use: 'webhook-signing',
    key_ops: ['verify'],
    use: 'sig',
  } as AdcpJsonWebKey;

  logger.warn(
    { tenantId, kid },
    'Tenant signing key generated ephemerally. Provision GCP KMS keys for stable kids.',
  );

  return { signingKey, publicJwk: brandJwk };
}

/**
 * Get-or-create signing material for a tenant. Memoizes per process.
 */
export function getTenantSigningMaterial(tenantId: string): TenantMaterial {
  let m = materials.get(tenantId);
  if (!m) {
    m = generateEphemeralKey(tenantId);
    materials.set(tenantId, m);
  }
  return m;
}

/** Generate an ephemeral Ed25519 response-signing keypair. Distinct kid +
 *  adcp_use from the webhook-signing key on the same tenant so the SDK's
 *  signResponse purpose-binding check passes against this key and only this
 *  key. */
function generateResponseSigningKey(tenantId: string): TenantResponseSigningMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = `training-${tenantId}-resp-${randomBytes(4).toString('hex')}`;

  const privateAdcpJwk: AdcpJsonWebKey = {
    ...privateJwk,
    kid,
    alg: 'EdDSA',
    adcp_use: 'response-signing',
    key_ops: ['sign'],
    use: 'sig',
  } as AdcpJsonWebKey;

  const signerKey: SignerKey = {
    keyid: kid,
    alg: 'ed25519',
    privateKey: privateAdcpJwk,
  };

  const brandJwk: AdcpJsonWebKey = {
    ...publicJwk,
    kid,
    alg: 'EdDSA',
    adcp_use: 'response-signing',
    key_ops: ['verify'],
    use: 'sig',
  } as AdcpJsonWebKey;

  logger.warn(
    { tenantId, kid },
    'Tenant response-signing key generated ephemerally. Provision KMS-backed keys for stable kids.',
  );

  return { signerKey, publicJwk: brandJwk };
}

/**
 * Get-or-create response-signing material for a tenant. Memoizes per process.
 * The SDK's signResponse will reject this key if its adcp_use isn't
 * "response-signing", which is why this is generated separately from
 * `getTenantSigningMaterial`'s webhook-scoped keys.
 */
export function getTenantResponseSigningMaterial(tenantId: string): TenantResponseSigningMaterial {
  let m = responseSigningMaterials.get(tenantId);
  if (!m) {
    m = generateResponseSigningKey(tenantId);
    responseSigningMaterials.set(tenantId, m);
  }
  return m;
}

/**
 * Aggregate public JWKs across all registered tenants. Served at the host's
 * `/.well-known/brand.json` so the SDK validator finds each tenant's kid in
 * one shared discovery document.
 *
 * Includes the governance-signing key alongside per-tenant transport keys.
 * The JWS profile requires governance keys to be discoverable on the
 * issuer's published JWKS but to occupy a distinct `kid` and `adcp_use`
 * from transport-signing material.
 */
export function getAggregatedPublicJwks(): { keys: AdcpJsonWebKey[] } {
  return {
    keys: [
      ...Array.from(materials.values()).map(m => m.publicJwk),
      ...Array.from(responseSigningMaterials.values()).map(m => m.publicJwk),
      getGovernanceSigningPublicJwk(),
    ],
  };
}

/** Reset state — tests only. */
export function resetTenantSigning(): void {
  materials.clear();
  responseSigningMaterials.clear();
}
