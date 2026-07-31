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

  it('selects only the active membership by default or explicit organization', () => {
    expect(selectedOrganizationMembership(memberships)).toEqual(memberships[1]);
    expect(selectedOrganizationMembership(memberships, 'org_active_member')).toEqual(memberships[1]);
  });

  it('uses the active selector across every WorkOS-backed profile route', async () => {
    const source = await readFile(new URL('../../src/routes/member-profiles.ts', import.meta.url), 'utf8');
    expect(source.match(/selectedOrganizationMembership\(memberships\.data, requestedOrgId\)/g)?.length)
      .toBeGreaterThanOrEqual(7);
    expect(source).toContain('Only organization admins or owners can update brand identity');
  });
});
