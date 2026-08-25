import { describe, expect, it } from 'vitest';
import type { MemberContext } from '../../src/addie/member-context.js';
import { resolveSlackDirectoryContext } from '../../src/addie/directory-access.js';

const paidMemberContext = {
  is_mapped: true,
  is_member: true,
  organization: {
    workos_organization_id: 'org-paid',
    name: 'Paid organization',
    subscription_status: 'active',
    is_personal: false,
    membership_tier: 'company_standard',
  },
} satisfies MemberContext;

describe('Slack directory audience scoping', () => {
  it('preserves member context only in DMs', () => {
    expect(resolveSlackDirectoryContext(paidMemberContext, 'dm')).toBe(paidMemberContext);
  });

  it('fails closed for every multi-reader Slack audience', () => {
    expect(resolveSlackDirectoryContext(paidMemberContext, 'mention')).toBeNull();
    expect(resolveSlackDirectoryContext(paidMemberContext, 'channel')).toBeNull();
    expect(resolveSlackDirectoryContext(paidMemberContext, undefined)).toBeNull();
  });
});
