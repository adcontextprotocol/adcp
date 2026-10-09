import { describe, expect, it, vi } from 'vitest';
import {
  verifyAndRefreshWorkosDomain,
  WorkosDomainOwnershipMismatchError,
} from '../../src/services/workos-domain-verification.js';

const EXPECTED = {
  id: 'org_domain_onx',
  organizationId: 'org_onx',
  domain: 'o-n-x.com',
};

function domain(overrides: Record<string, unknown> = {}) {
  return {
    object: 'organization_domain',
    ...EXPECTED,
    state: 'pending',
    verificationStrategy: 'dns',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function workos(verifyResult: unknown, refreshResult: unknown) {
  return {
    organizationDomains: {
      verifyOrganizationDomain: vi.fn().mockImplementation(async () => {
        if (verifyResult instanceof Error) throw verifyResult;
        return verifyResult;
      }),
      getOrganizationDomain: vi.fn().mockResolvedValue(refreshResult),
    },
  };
}

describe('verifyAndRefreshWorkosDomain', () => {
  it('recovers when verify reports pending but the canonical refresh is verified', async () => {
    const pending = Object.assign(new Error('not found yet'), { status: 422 });
    const client = workos(pending, domain({ state: 'verified' }));

    await expect(verifyAndRefreshWorkosDomain({
      workos: client as any,
      ...EXPECTED,
      domainId: EXPECTED.id,
    })).resolves.toMatchObject({ status: 'verified', newlyVerified: true });
    expect(client.organizationDomains.getOrganizationDomain).toHaveBeenCalledWith(EXPECTED.id);
  });

  it('refreshes a successful but stale pending verify response', async () => {
    const client = workos(domain(), domain({ state: 'verified' }));

    const result = await verifyAndRefreshWorkosDomain({
      workos: client as any,
      ...EXPECTED,
      domainId: EXPECTED.id,
    });

    expect(result.status).toBe('verified');
    expect(client.organizationDomains.getOrganizationDomain).toHaveBeenCalledOnce();
  });

  it('returns pending only after the canonical refresh remains pending', async () => {
    const pending = Object.assign(new Error('not found yet'), { response: { status: 400 } });
    const client = workos(pending, domain());

    await expect(verifyAndRefreshWorkosDomain({
      workos: client as any,
      ...EXPECTED,
      domainId: EXPECTED.id,
    })).resolves.toMatchObject({ status: 'pending' });
  });

  it.each([
    { organizationId: 'org_someone_else' },
    { domain: 'someone-else.example' },
    { id: 'org_domain_replaced' },
  ])('rejects refreshed ownership drift before local state can change: %j', async (drift) => {
    const pending = Object.assign(new Error('not found yet'), { status: 422 });
    const client = workos(pending, domain(drift));

    await expect(verifyAndRefreshWorkosDomain({
      workos: client as any,
      ...EXPECTED,
      domainId: EXPECTED.id,
    })).rejects.toBeInstanceOf(WorkosDomainOwnershipMismatchError);
  });
});
