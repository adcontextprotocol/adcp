import { describe, expect, it, vi } from 'vitest';
import { guardPersonalWorkspaceDomainSelection } from '../../src/services/org-selection-guard.js';

function makePool(rows: Array<{ workos_organization_id: string; name: string | null }>) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe('guardPersonalWorkspaceDomainSelection', () => {
  it('does not query when the selected org is not personal', async () => {
    const pool = makePool([]);
    const result = await guardPersonalWorkspaceDomainSelection({
      memberContext: {
        workos_user: { workos_user_id: 'user_123' },
        organization: {
          workos_organization_id: 'org_company',
          name: 'Company',
          is_personal: false,
        },
      },
      selectedOrgId: 'org_company',
      rawDomain: 'example.com',
      pool: pool as any,
    });

    expect(result).toEqual({ ok: true, checked: false });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('stops before mutation when a personal workspace domain maps to a company org for the same user', async () => {
    const pool = makePool([
      { workos_organization_id: 'org_company', name: 'Example Co' },
    ]);

    const result = await guardPersonalWorkspaceDomainSelection({
      memberContext: {
        workos_user: { workos_user_id: 'user_123' },
        organization: {
          workos_organization_id: 'org_personal',
          name: "User's Workspace",
          is_personal: true,
        },
      },
      selectedOrgId: 'org_personal',
      rawDomain: 'https://agent.example.com/path',
      pool: pool as any,
    });

    expect(result).toEqual({
      ok: false,
      status: 'org_selection_required',
      domain: 'example.com',
      selectedOrg: {
        organizationId: 'org_personal',
        name: "User's Workspace",
      },
      companyOrgs: [
        {
          organizationId: 'org_company',
          name: 'Example Co',
        },
      ],
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('organization_memberships'), [
      'example.com',
      'user_123',
      'org_personal',
    ]);
  });

  it('checks the explicit selected org, not just ambient context', async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              workos_organization_id: 'org_personal',
              name: "User's Workspace",
              is_personal: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ workos_organization_id: 'org_company', name: 'Example Co' }],
        }),
    };

    const result = await guardPersonalWorkspaceDomainSelection({
      memberContext: {
        workos_user: { workos_user_id: 'user_123' },
        organization: {
          workos_organization_id: 'org_ambient_company',
          name: 'Ambient Company',
          is_personal: false,
        },
      },
      selectedOrgId: 'org_personal',
      rawDomain: 'agent.example.com',
      pool: pool as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.selectedOrg).toEqual({
        organizationId: 'org_personal',
        name: "User's Workspace",
      });
      expect(result.companyOrgs).toEqual([
        { organizationId: 'org_company', name: 'Example Co' },
      ]);
    }
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE workos_organization_id = $1'),
      ['org_personal'],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('organization_memberships'),
      ['example.com', 'user_123', 'org_personal'],
    );
  });

  it('allows the action when no matching company org exists', async () => {
    const pool = makePool([]);
    const result = await guardPersonalWorkspaceDomainSelection({
      memberContext: {
        workos_user: { workos_user_id: 'user_123' },
        organization: {
          workos_organization_id: 'org_personal',
          name: "User's Workspace",
          is_personal: true,
        },
      },
      selectedOrgId: 'org_personal',
      rawDomain: 'example.com',
      pool: pool as any,
    });

    expect(result).toEqual({ ok: true, checked: true, domain: 'example.com' });
  });
});
