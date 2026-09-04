import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const peopleUi = readFileSync(resolve(process.cwd(), 'server/public/admin-people.html'), 'utf8');
const workingGroupsUi = readFileSync(resolve(process.cwd(), 'server/public/admin-working-groups.html'), 'utf8');

describe('site-admin membership UI affordance', () => {
  it('reuses the working-group membership view with target and group context', () => {
    expect(peopleUi).toContain('AAO site-admin access');
    expect(peopleUi).toContain('group=aao-admin&user=');
    expect(peopleUi).toContain('WorkOS organization roles never grant AgenticAdvertising.org platform administration.');
    expect(workingGroupsUi).toContain('function applyMembershipDeepLink()');
    expect(workingGroupsUi).toContain("params.get('tab') !== 'members'");
    expect(workingGroupsUi).toContain('m.workos_user_id');
    expect(workingGroupsUi).toContain('/api/admin/aao-admin/grant');
    expect(workingGroupsUi).toContain('/api/admin/aao-admin/revoke');
    expect(workingGroupsUi).toContain('reason.trim()');
  });
});
