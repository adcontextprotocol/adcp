import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { selectedOrganizationMembership } from '../../src/routes/member-profiles.js';

describe('member profile membership authorization', () => {
  const memberships = [
    {
      organizationId: 'org_pending_admin',
      status: 'pending',
      role: { slug: 'admin' },
    },
    {
      organizationId: 'org_active_member',
      status: 'active',
      role: { slug: 'member' },
    },
  ];

  it('never selects a pending admin membership for profile mutations', () => {
    expect(selectedOrganizationMembership(memberships, 'org_pending_admin')).toBeNull();
  });

  it('never selects an organization implicitly', () => {
    expect(selectedOrganizationMembership(memberships)).toBeNull();
    expect(selectedOrganizationMembership(memberships, 'org_active_member')).toEqual(memberships[1]);
  });

  it('uses the exact credential resolver across WorkOS-backed profile routes', async () => {
    const source = await readFile(new URL('../../src/routes/member-profiles.ts', import.meta.url), 'utf8');
    expect(source.match(/resolveUserOrgMembership\(workos!, user,/g)?.length)
      .toBeGreaterThanOrEqual(7);
    expect(source).not.toContain('listOrganizationMemberships({\n          userId: user.id');
    expect(source).toContain('Only organization admins or owners can update brand identity');
  });

  it('attributes organization-scoped profile mutations to the authenticated credential', async () => {
    const source = await readFile(new URL('../../src/routes/member-profiles.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/set_by_user_id:\s*user\.id/);
    expect(source).not.toMatch(/recordProfilePublishedIfNeeded\([\s\S]{0,180}?user\.id\s*\)/);
    expect(source).toContain('workos_user_id: actorCredentialId');
    expect(source).toContain('workos_user_id: getOrganizationAuthorizationUserId(user)');
  });
});
