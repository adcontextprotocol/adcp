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

import { generateKeyPairSync } from 'node:crypto';
import type { TenantSigningKey } from '@adcp/sdk/server';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { createLogger } from '../../logger.js';

const logger = createLogger('training-agent-tenant-signing');

interface TenantMaterial {
  signingKey: TenantSigningKey;
  publicJwk: AdcpJsonWebKey;
}

const materials: Map<string, TenantMaterial> = new Map();

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
  const kid = `training-${tenantId}-${Math.random().toString(16).slice(2, 10)}`;

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

/**
 * Aggregate public JWKs across all registered tenants. Served at the host's
 * `/.well-known/brand.json` so the SDK validator finds each tenant's kid in
 * one shared discovery document.
 */
export function getAggregatedPublicJwks(): { keys: AdcpJsonWebKey[] } {
  return { keys: Array.from(materials.values()).map(m => m.publicJwk) };
}

/** Reset state — tests only. */
export function resetTenantSigning(): void {
  materials.clear();
}
