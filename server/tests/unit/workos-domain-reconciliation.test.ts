import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncOrganizationDomains: vi.fn(),
}));

vi.mock('../../src/routes/workos-webhooks.js', () => ({
  syncOrganizationDomains: mocks.syncOrganizationDomains,
}));

import { reconcileWorkosOrganizationDomains } from '../../src/services/workos-domain-reconciliation.js';

function makeWorkos(domains: Array<{ domain: string; state: string }>) {
  return {
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({
        id: 'org_company',
        name: 'Company',
        domains,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    },
  };
}

function makePool(rowsByCall: unknown[][]) {
  return {
    query: vi.fn().mockImplementation(async () => ({
      rows: rowsByCall.shift() ?? [],
    })),
  };
}

describe('reconcileWorkosOrganizationDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps verified and legacy_verified WorkOS states into verified sync data', async () => {
    const workos = makeWorkos([
      { domain: 'example.com', state: 'verified' },
      { domain: 'legacy.example', state: 'legacy_verified' },
    ]);
    const pool = makePool([
      [],
      [
        {
          domain: 'example.com',
          workos_organization_id: 'org_company',
          organization_name: 'Company',
          verified: true,
          is_primary: false,
          source: 'workos',
        },
        {
          domain: 'legacy.example',
          workos_organization_id: 'org_company',
          organization_name: 'Company',
          verified: true,
          is_primary: false,
          source: 'workos',
        },
      ],
    ]);

    const result = await reconcileWorkosOrganizationDomains({
      workos: workos as any,
      orgId: 'org_company',
      pool: pool as any,
    });

    expect(mocks.syncOrganizationDomains).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org_company',
        domains: [
          { domain: 'example.com', state: 'verified' },
          { domain: 'legacy.example', state: 'verified' },
        ],
      }),
    );
    expect(result.before_mismatches.map((m) => m.reason)).toEqual([
      'missing_local_row',
      'missing_local_row',
    ]);
    expect(result.after_mismatches).toEqual([]);
  });

  it('reports remaining mismatches after sync', async () => {
    const workos = makeWorkos([{ domain: 'example.com', state: 'verified' }]);
    const wrongLocalRow = {
      domain: 'example.com',
      workos_organization_id: 'org_wrong',
      organization_name: 'Wrong Org',
      verified: true,
      is_primary: false,
      source: 'workos',
    };
    const pool = makePool([[wrongLocalRow], [wrongLocalRow]]);

    const result = await reconcileWorkosOrganizationDomains({
      workos: workos as any,
      orgId: 'org_company',
      pool: pool as any,
    });

    expect(result.before_mismatches).toEqual([
      expect.objectContaining({ reason: 'wrong_local_org', domain: 'example.com' }),
    ]);
    expect(result.after_mismatches).toEqual([
      expect.objectContaining({ reason: 'wrong_local_org', domain: 'example.com' }),
    ]);
  });

  it('passes zero WorkOS domains through to the canonical sync path', async () => {
    const workos = makeWorkos([]);
    const pool = makePool([]);

    const result = await reconcileWorkosOrganizationDomains({
      workos: workos as any,
      orgId: 'org_company',
      pool: pool as any,
    });

    expect(mocks.syncOrganizationDomains).toHaveBeenCalledWith(
      expect.objectContaining({ domains: [] }),
    );
    expect(result.workos_domains).toEqual([]);
    expect(result.before_mismatches).toEqual([]);
    expect(result.after_mismatches).toEqual([]);
  });
});
