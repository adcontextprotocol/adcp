import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPlatformBan: vi.fn(),
  checkPlatformBanForUserAndOrg: vi.fn(),
  listOrganizationMemberships: vi.fn(),
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBan: mocks.checkPlatformBan,
    checkPlatformBanForUserAndOrg: mocks.checkPlatformBanForUserAndOrg,
  },
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({
    userManagement: {
      listOrganizationMemberships: mocks.listOrganizationMemberships,
    },
  }),
}));

import { authorizeMCPPrincipal } from '../../src/mcp/principal-authorization.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkPlatformBan.mockResolvedValue({ banned: false });
  mocks.checkPlatformBanForUserAndOrg.mockResolvedValue({ banned: false });
  mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
});

describe('authorizeMCPPrincipal', () => {
  it('denies missing and anonymous principals', async () => {
    await expect(authorizeMCPPrincipal(undefined)).resolves.toEqual({
      authorized: false,
      reason: 'authentication_required',
    });
    await expect(authorizeMCPPrincipal({
      sub: 'anonymous',
      isM2M: false,
      payload: {},
    })).resolves.toEqual({
      authorized: false,
      reason: 'authentication_required',
    });
    expect(mocks.checkPlatformBan).not.toHaveBeenCalled();
  });

  it('denies machine tokens because AAO MCP has no client_credentials policy', async () => {
    await expect(authorizeMCPPrincipal({
      sub: 'client_123',
      orgId: 'org_123',
      isM2M: true,
      payload: {},
    })).resolves.toEqual({
      authorized: false,
      reason: 'machine_token_not_supported',
    });
    expect(mocks.checkPlatformBan).not.toHaveBeenCalled();
  });

  it('denies a platform-banned user before resolving membership', async () => {
    mocks.checkPlatformBanForUserAndOrg.mockResolvedValue({ banned: true, ban: { id: 'ban_123' } });

    await expect(authorizeMCPPrincipal({
      sub: 'user_123',
      orgId: 'org_123',
      isM2M: false,
      payload: {},
    })).resolves.toEqual({
      authorized: false,
      reason: 'platform_banned',
    });
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.checkPlatformBanForUserAndOrg).toHaveBeenCalledWith('user_123', 'org_123');
  });

  it('checks the claimed organization directly instead of relying on the membership mirror', async () => {
    mocks.checkPlatformBanForUserAndOrg.mockResolvedValue({ banned: true, ban: { id: 'org_ban' } });

    await expect(authorizeMCPPrincipal({
      sub: 'new_user_not_yet_mirrored',
      orgId: 'banned_org',
      isM2M: false,
      payload: {},
    })).resolves.toEqual({ authorized: false, reason: 'platform_banned' });

    expect(mocks.checkPlatformBanForUserAndOrg).toHaveBeenCalledWith(
      'new_user_not_yet_mirrored',
      'banned_org',
    );
    expect(mocks.checkPlatformBan).not.toHaveBeenCalled();
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it('allows an unbanned user token without an organization claim', async () => {
    await expect(authorizeMCPPrincipal({
      sub: 'user_123',
      isM2M: false,
      payload: {},
    })).resolves.toEqual({ authorized: true });
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it('allows a current active member of the claimed organization', async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        { userId: 'user_123', organizationId: 'org_123', status: 'active' },
      ],
    });

    await expect(authorizeMCPPrincipal({
      sub: 'user_123',
      orgId: 'org_123',
      isM2M: false,
      payload: {},
    })).resolves.toEqual({ authorized: true });
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith({
      userId: 'user_123',
      organizationId: 'org_123',
    });
  });

  it('denies a former member even when the JWT still claims the organization', async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        { userId: 'user_123', organizationId: 'org_123', status: 'inactive' },
      ],
    });

    await expect(authorizeMCPPrincipal({
      sub: 'user_123',
      orgId: 'org_123',
      isM2M: false,
      payload: {},
    })).resolves.toEqual({
      authorized: false,
      reason: 'inactive_organization_membership',
    });
  });

  it('fails closed when ban or membership dependencies fail', async () => {
    mocks.checkPlatformBan.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(authorizeMCPPrincipal({
      sub: 'user_123',
      isM2M: false,
      payload: {},
    })).rejects.toThrow('database unavailable');

    mocks.checkPlatformBanForUserAndOrg.mockResolvedValue({ banned: false });
    mocks.listOrganizationMemberships.mockRejectedValueOnce(new Error('WorkOS unavailable'));
    await expect(authorizeMCPPrincipal({
      sub: 'user_123',
      orgId: 'org_123',
      isM2M: false,
      payload: {},
    })).rejects.toThrow('WorkOS unavailable');
  });
});
