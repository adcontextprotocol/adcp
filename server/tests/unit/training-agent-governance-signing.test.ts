/**
 * Governance-signing key publication tests.
 *
 * The JWS profile requires the governance-signing key to be discoverable on
 * the issuer's published JWKS but to occupy a distinct `kid` and a distinct
 * `adcp_use` from any transport-signing or webhook-signing material on the
 * same JWKS. Receivers enforce purpose at the JWK level.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  getGovernanceSigningPublicJwk,
  getGovernanceSigningKey,
  resetGovernanceSigning,
} from '../../src/training-agent/governance-signing.js';
import {
  getAggregatedPublicJwks,
  getTenantSigningMaterial,
  resetTenantSigning,
} from '../../src/training-agent/tenants/signing.js';

describe('governance-signing JWK publication', () => {
  beforeEach(() => {
    resetGovernanceSigning();
    resetTenantSigning();
  });

  it('publishes a single governance-signing JWK with the required wire-shape', () => {
    const jwk = getGovernanceSigningPublicJwk();
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.adcp_use).toBe('governance-signing');
    expect(jwk.use).toBe('sig');
    expect(jwk.key_ops).toEqual(['verify']);
    expect(typeof jwk.kid).toBe('string');
    expect(jwk.kid).toMatch(/^training-gov-/);
    expect(jwk).not.toHaveProperty('d');
  });

  it('memoizes — kid and material are stable within a process', () => {
    const a = getGovernanceSigningPublicJwk();
    const b = getGovernanceSigningPublicJwk();
    expect(b.kid).toBe(a.kid);
    expect(b.x).toBe(a.x);

    const signA = getGovernanceSigningKey();
    const signB = getGovernanceSigningKey();
    expect(signB.kid).toBe(signA.kid);
    expect(signB.privateKey).toBe(signA.privateKey);
  });

  it('aggregated brand.json JWKS includes the governance key', () => {
    // Force at least one transport-signing entry so we can verify ordering
    // doesn't displace governance.
    getTenantSigningMaterial('governance');
    const aggregated = getAggregatedPublicJwks();

    const governanceKeys = aggregated.keys.filter(k => k.adcp_use === 'governance-signing');
    expect(governanceKeys).toHaveLength(1);
    expect(governanceKeys[0].kid).toBe(getGovernanceSigningPublicJwk().kid);
  });

  it('governance kid is distinct from every transport kid (no cross-purpose collision)', () => {
    getTenantSigningMaterial('governance');
    getTenantSigningMaterial('sales');
    getTenantSigningMaterial('signals');

    const aggregated = getAggregatedPublicJwks();
    const govKid = getGovernanceSigningPublicJwk().kid;

    const otherKids = aggregated.keys
      .filter(k => k.adcp_use !== 'governance-signing')
      .map(k => k.kid);

    expect(otherKids).not.toContain(govKid);
    // Sanity: there's at least one transport key to compare against.
    expect(otherKids.length).toBeGreaterThan(0);
  });

  it('every aggregated JWK declares a single adcp_use string (not an array)', () => {
    getTenantSigningMaterial('governance');
    const aggregated = getAggregatedPublicJwks();
    for (const key of aggregated.keys) {
      expect(typeof key.adcp_use).toBe('string');
    }
  });
});
