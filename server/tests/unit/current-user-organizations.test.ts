import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import {
  CurrentUserOrganizationsUnavailableError,
  getCurrentUserOrganizations,
  getMembershipRole,
  resolveCurrentUserOrganization,
} from '../../src/routes/current-user-organizations.js';

describe('current user organization resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({
      rows: [{
        workos_organization_id: 'org_cached',
        name: 'Cached Org',
        role: 'admin',
        is_personal: false,
      }],
    });
  });

  it('does not trust cached local memberships when WorkOS membership lookup fails', async () => {
    const workos = {
      userManagement: {
        listOrganizationMemberships: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
      },
      organizations: {
        getOrganization: vi.fn(),
      },
    } as any;

    await expect(getCurrentUserOrganizations({
      userId: 'user_123',
      email: 'user@example.com',
      workos,
      orgDb: { getOrganization: vi.fn() },
      autoLinkByVerifiedDomain: vi.fn(),
    })).rejects.toBeInstanceOf(CurrentUserOrganizationsUnavailableError);

    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('uses cached local memberships when WorkOS is not configured', async () => {
    const organizations = await getCurrentUserOrganizations({
      userId: 'user_123',
      email: 'user@example.com',
      workos: null,
      orgDb: { getOrganization: vi.fn() },
      autoLinkByVerifiedDomain: vi.fn(),
    });

    expect(organizations).toEqual([{
      id: 'org_cached',
      name: 'Cached Org',
      role: 'admin',
      status: 'active',
      is_personal: false,
    }]);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM organization_memberships om'), ['user_123']);
  });

  it('uses local organization details when WorkOS org detail lookup fails', async () => {
    const workos = {
      organizations: {
        getOrganization: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
      },
    } as any;
    const orgDb = {
      getOrganization: vi.fn().mockResolvedValue({
        name: 'Local Org',
        is_personal: true,
      }),
    };

    const organization = await resolveCurrentUserOrganization({
      organizationId: 'org_123',
      role: { slug: 'owner' },
      status: 'active',
    }, orgDb, workos);

    expect(organization).toEqual({
      id: 'org_123',
      name: 'Local Org',
      role: 'owner',
      status: 'active',
      is_personal: true,
    });
  });

  it('refreshes WorkOS memberships after verified-domain auto-link succeeds', async () => {
    const listOrganizationMemberships = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{
          organizationId: 'org_linked',
          role: { slug: 'member' },
          status: 'active',
        }],
      });
    const workos = {
      userManagement: { listOrganizationMemberships },
      organizations: {
        getOrganization: vi.fn().mockResolvedValue({ name: 'Linked Org' }),
      },
    } as any;

    const organizations = await getCurrentUserOrganizations({
      userId: 'user_123',
      email: 'user@example.com',
      workos,
      orgDb: { getOrganization: vi.fn().mockResolvedValue({ is_personal: false }) },
      autoLinkByVerifiedDomain: vi.fn().mockResolvedValue(true),
    });

    expect(listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(organizations).toEqual([{
      id: 'org_linked',
      name: 'Linked Org',
      role: 'member',
      status: 'active',
      is_personal: false,
    }]);
  });

  it('normalizes missing or blank membership roles to member', () => {
    expect(getMembershipRole(undefined)).toBe('member');
    expect(getMembershipRole({ slug: '' })).toBe('member');
    expect(getMembershipRole(' owner ')).toBe('owner');
  });
});
