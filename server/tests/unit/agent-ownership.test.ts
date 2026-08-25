import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({ getWorkos: vi.fn(() => ({ marker: 'workos' })) }));
vi.mock('../../src/utils/resolve-user-org-membership.js', () => ({
  resolveUserOrgMembership: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { resolveUserOrgMembership } from '../../src/utils/resolve-user-org-membership.js';
import {
  findOwnedAgentVisibility,
  isOrgOwnerOfAgent,
  resolveOwnerOrgForUser,
} from '../../src/services/agent-ownership.js';

const queryMock = vi.mocked(query);
const membershipMock = vi.mocked(resolveUserOrgMembership);
const principal = { id: 'user_primary_b', authWorkosUserId: 'user_credential_a' };

describe('agent ownership authorization', () => {
  beforeEach(() => {
    queryMock.mockReset();
    membershipMock.mockReset();
  });

  it('requires an explicit organization', async () => {
    await expect(resolveOwnerOrgForUser(principal, 'https://agent.example/mcp', undefined))
      .resolves.toBeNull();
    expect(membershipMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('fails before ownership lookup when the exact credential lacks live access', async () => {
    membershipMock.mockResolvedValue(null);
    await expect(resolveOwnerOrgForUser(principal, 'https://agent.example/mcp', 'org_b'))
      .resolves.toBeNull();
    expect(membershipMock).toHaveBeenCalledWith(
      expect.anything(),
      principal,
      'org_b',
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does not substitute the canonical primary credential for linked credential A', async () => {
    membershipMock.mockImplementation(async (_workos, receivedPrincipal) => {
      return receivedPrincipal.authWorkosUserId === 'user_credential_a' ? null : {
        organizationId: 'org_b',
        role: 'owner',
      } as never;
    });
    await expect(resolveOwnerOrgForUser(principal, 'https://agent.example/mcp', 'org_b'))
      .resolves.toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns the explicit org only when live access and ownership both hold', async () => {
    membershipMock.mockResolvedValue({ organizationId: 'org_a', role: 'member' } as never);
    queryMock.mockResolvedValue({ rows: [{ '?column?': 1 }] } as never);

    await expect(resolveOwnerOrgForUser(principal, 'HTTPS://Agent.Example/MCP///', 'org_a'))
      .resolves.toBe('org_a');
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      'org_a',
      JSON.stringify([{ url: 'https://agent.example/mcp' }]),
    ]);
  });

  it('fails when the selected org does not own the agent', async () => {
    membershipMock.mockResolvedValue({ organizationId: 'org_wrong', role: 'owner' } as never);
    queryMock.mockResolvedValue({ rows: [] } as never);
    await expect(resolveOwnerOrgForUser(principal, 'https://agent.example/mcp', 'org_wrong'))
      .resolves.toBeNull();
  });

  it('checks ownership without joining the stale local membership mirror', async () => {
    queryMock.mockResolvedValue({ rows: [{ '?column?': 1 }] } as never);
    await expect(isOrgOwnerOfAgent('org_a', 'user_credential_a', 'https://agent.example/mcp'))
      .resolves.toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).not.toContain('organization_memberships');
    expect(params).toEqual(['org_a', JSON.stringify([{ url: 'https://agent.example/mcp' }])]);
  });

  it('reads visibility only inside an already-authorized organization', async () => {
    queryMock.mockResolvedValue({ rows: [{ visibility: 'members_only' }] } as never);
    await expect(findOwnedAgentVisibility('org_a', 'https://agent.example/mcp'))
      .resolves.toBe('members_only');
    expect(queryMock.mock.calls[0]?.[1]).toEqual(['org_a', 'https://agent.example/mcp']);
  });
});
