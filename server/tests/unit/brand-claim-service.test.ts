import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
  query: vi.fn(),
}));

import {
  issueDomainChallenge,
  verifyDomainChallenge,
  _resetVerifyCooldown,
} from '../../src/services/brand-claim.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';
import type { HostedBrand } from '../../src/types.js';

type WorkOSStub = {
  organizations: { getOrganization: ReturnType<typeof vi.fn> };
  organizationDomains: {
    createOrganizationDomain: ReturnType<typeof vi.fn>;
    verifyOrganizationDomain: ReturnType<typeof vi.fn>;
  };
};

function makeWorkos(overrides: Partial<{
  getOrganization: any;
  createOrganizationDomain: any;
  verifyOrganizationDomain: any;
}> = {}): WorkOSStub {
  return {
    organizations: {
      getOrganization: overrides.getOrganization ?? vi.fn().mockResolvedValue({ domains: [] }),
    },
    organizationDomains: {
      createOrganizationDomain: overrides.createOrganizationDomain ?? vi.fn(),
      verifyOrganizationDomain: overrides.verifyOrganizationDomain ?? vi.fn(),
    },
  };
}

function makeBrandDb(overrides: Partial<{
  getHostedBrandByDomain: any;
  applyVerifiedBrandClaim: any;
}> = {}): BrandDatabase {
  return {
    getHostedBrandByDomain: overrides.getHostedBrandByDomain ?? vi.fn().mockResolvedValue(null),
    applyVerifiedBrandClaim: overrides.applyVerifiedBrandClaim ?? vi.fn().mockResolvedValue(null),
  } as unknown as BrandDatabase;
}

const ORG = 'org_test_brand_claim';
const DOMAIN = 'acme.com';

describe('issueDomainChallenge', () => {
  beforeEach(() => _resetVerifyCooldown());

  it('rejects empty domain with invalid_domain', async () => {
    const result = await issueDomainChallenge({
      workos: makeWorkos() as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_domain');
  });

  it('rejects shared-platform apex domains with invalid_domain', async () => {
    const result = await issueDomainChallenge({
      workos: makeWorkos() as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: 'vercel.app',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_domain');
  });

  it('rejects public-suffix domains with invalid_domain', async () => {
    const result = await issueDomainChallenge({
      workos: makeWorkos() as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: 'co.uk',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_domain');
  });

  it('returns existing pending domain when already attached to caller org (idempotent re-issue)', async () => {
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{
          id: 'dom_123',
          domain: DOMAIN,
          state: 'pending',
          verificationStrategy: 'dns',
          verificationToken: 'tok_abc',
          verificationPrefix: '_workos-challenge',
        }],
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workos_domain_id).toBe('dom_123');
      expect(result.verification_token).toBe('tok_abc');
      expect(result.already_verified).toBe(false);
    }
    expect(workos.organizationDomains.createOrganizationDomain).not.toHaveBeenCalled();
  });

  it('flags already_verified when existing domain state is verified', async () => {
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{
          id: 'dom_v',
          domain: DOMAIN,
          state: 'verified',
          verificationStrategy: 'dns',
          verificationToken: 'tok_v',
          verificationPrefix: '_workos-challenge',
        }],
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.already_verified).toBe(true);
  });

  it('disambiguates 422 collision via organization_domain_already_used code', async () => {
    const workos = makeWorkos({
      createOrganizationDomain: vi.fn().mockRejectedValue({
        status: 422,
        rawResponse: { code: 'organization_domain_already_used', message: 'already used' },
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('collision');
  });

  it('disambiguates 422 collision via message regex when no code field', async () => {
    const workos = makeWorkos({
      createOrganizationDomain: vi.fn().mockRejectedValue({
        status: 422,
        rawResponse: { message: 'Domain already exists in another organization' },
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('collision');
  });

  it('treats generic 422 (no collision signal) as invalid_domain', async () => {
    const workos = makeWorkos({
      createOrganizationDomain: vi.fn().mockRejectedValue({
        status: 422,
        rawResponse: { message: 'Invalid format' },
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_domain');
  });

  it('returns prior_manifest_exists=true when brand row is orphaned with non-empty manifest', async () => {
    const orphanedBrand = {
      id: 'b1',
      brand_domain: DOMAIN,
      brand_json: { logos: [{ url: 'x' }] },
      domain_verified: false,
      is_public: true,
      manifest_orphaned: true,
      created_at: new Date(),
      updated_at: new Date(),
    } as HostedBrand;
    const workos = makeWorkos({
      createOrganizationDomain: vi.fn().mockResolvedValue({
        id: 'dom_new',
        state: 'pending',
        verificationStrategy: 'dns',
        verificationToken: 'tok',
        verificationPrefix: '_workos-challenge',
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb({
        getHostedBrandByDomain: vi.fn().mockResolvedValue(orphanedBrand),
      }),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prior_manifest_exists).toBe(true);
  });

  it('returns prior_manifest_exists=false when brand row exists but is not orphaned', async () => {
    const brand = {
      id: 'b1',
      brand_domain: DOMAIN,
      brand_json: { logos: [{ url: 'x' }] },
      domain_verified: true,
      is_public: true,
      manifest_orphaned: false,
      created_at: new Date(),
      updated_at: new Date(),
    } as HostedBrand;
    const workos = makeWorkos({
      createOrganizationDomain: vi.fn().mockResolvedValue({
        id: 'dom_new',
        state: 'pending',
        verificationStrategy: 'dns',
        verificationToken: 'tok',
        verificationPrefix: '_workos-challenge',
      }),
    });
    const result = await issueDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb({
        getHostedBrandByDomain: vi.fn().mockResolvedValue(brand),
      }),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prior_manifest_exists).toBe(false);
  });
});

describe('verifyDomainChallenge', () => {
  beforeEach(() => _resetVerifyCooldown());

  it('returns no_challenge when domain is not on the org', async () => {
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({ domains: [] }),
    });
    const result = await verifyDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_challenge');
  });

  it('returns ok with newly_verified=false when domain is already verified', async () => {
    const updatedBrand = {
      brand_domain: DOMAIN,
      domain_verified: true,
    } as HostedBrand;
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{ id: 'd1', domain: DOMAIN, state: 'verified' }],
      }),
    });
    const brandDb = makeBrandDb({
      applyVerifiedBrandClaim: vi.fn().mockResolvedValue(updatedBrand),
    });
    const result = await verifyDomainChallenge({
      workos: workos as any,
      brandDb,
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newly_verified).toBe(false);
      expect(result.brand?.brand_domain).toBe(DOMAIN);
      expect(result.brand?.domain_verified).toBe(true);
    }
    expect(workos.organizationDomains.verifyOrganizationDomain).not.toHaveBeenCalled();
  });

  it('returns still_pending on 422 from workos.verify', async () => {
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{ id: 'd1', domain: DOMAIN, state: 'pending' }],
      }),
      verifyOrganizationDomain: vi.fn().mockRejectedValue({ status: 422 }),
    });
    const result = await verifyDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('still_pending');
  });

  it('returns ok with newly_verified=true on a fresh verify success', async () => {
    const updatedBrand = {
      brand_domain: DOMAIN,
      domain_verified: true,
    } as HostedBrand;
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{ id: 'd1', domain: DOMAIN, state: 'pending' }],
      }),
      verifyOrganizationDomain: vi.fn().mockResolvedValue({ state: 'verified' }),
    });
    const brandDb = makeBrandDb({
      applyVerifiedBrandClaim: vi.fn().mockResolvedValue(updatedBrand),
    });
    const result = await verifyDomainChallenge({
      workos: workos as any,
      brandDb,
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newly_verified).toBe(true);
      expect(result.brand?.brand_domain).toBe(DOMAIN);
    }
  });

  it('enforces a cooldown between verify attempts when the first call is still pending', async () => {
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{ id: 'd1', domain: DOMAIN, state: 'pending' }],
      }),
      verifyOrganizationDomain: vi.fn().mockRejectedValue({ status: 422 }),
    });
    // First call → still_pending
    const first = await verifyDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(first.ok).toBe(false);
    // Second call within cooldown → still_pending with retry_after_seconds, never reaches workos.verify
    const second = await verifyDomainChallenge({
      workos: workos as any,
      brandDb: makeBrandDb(),
      orgId: ORG,
      rawDomain: DOMAIN,
    });
    expect(second.ok).toBe(false);
    if (!second.ok && second.code === 'still_pending') {
      expect(second.retry_after_seconds).toBeGreaterThan(0);
    }
    expect(workos.organizationDomains.verifyOrganizationDomain).toHaveBeenCalledTimes(1);
  });

  it('clears the cooldown after a successful verify so a follow-up returns the already-verified path', async () => {
    const updatedBrand = { brand_domain: DOMAIN, domain_verified: true } as HostedBrand;
    const workos = makeWorkos({
      getOrganization: vi.fn().mockResolvedValue({
        domains: [{ id: 'd1', domain: DOMAIN, state: 'verified' }],
      }),
    });
    const brandDb = makeBrandDb({
      applyVerifiedBrandClaim: vi.fn().mockResolvedValue(updatedBrand),
    });
    const first = await verifyDomainChallenge({
      workos: workos as any, brandDb, orgId: ORG, rawDomain: DOMAIN,
    });
    expect(first.ok).toBe(true);
    const second = await verifyDomainChallenge({
      workos: workos as any, brandDb, orgId: ORG, rawDomain: DOMAIN,
    });
    expect(second.ok).toBe(true);
  });
});
