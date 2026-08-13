import { describe, expect, it, vi } from 'vitest';
import {
  hasActiveMembershipForUser,
  type ActiveMembershipCheckDeps,
} from '../../src/services/active-membership-service.js';
import type { EffectiveMembership } from '../../src/db/org-filters.js';

function membership(overrides: Partial<EffectiveMembership> = {}): EffectiveMembership {
  return {
    is_member: false,
    is_inherited: false,
    paying_org_id: null,
    paying_org_name: null,
    hierarchy_chain: [],
    membership_tier: null,
    ...overrides,
  };
}

function deps(
  organizationIds: string[],
  resolve: ActiveMembershipCheckDeps['resolveEffectiveMembership'],
): ActiveMembershipCheckDeps {
  return {
    listOrganizationIdsForUser: vi.fn().mockResolvedValue(organizationIds),
    invalidateMembershipCache: vi.fn(),
    resolveEffectiveMembership: resolve,
  };
}

describe('active membership checks for Mastermind Councils', () => {
  it.each([
    ['no organizations', []],
    ['a free/community organization', ['org_free']],
    ['a canceled organization', ['org_canceled']],
  ])('denies a user with %s', async (_label, organizationIds) => {
    const resolve = vi.fn().mockResolvedValue(membership());

    await expect(hasActiveMembershipForUser('user_1', deps(organizationIds, resolve))).resolves.toBe(false);

    expect(resolve).toHaveBeenCalledTimes(organizationIds.length);
  });

  it.each([
    ['individual_academic', false],
    ['individual_professional', false],
    ['company_standard', false],
    ['company_icl', true],
    ['company_leader', true],
  ])('allows active %s membership, including inherited membership', async (tier, inherited) => {
    const resolve = vi.fn().mockResolvedValue(membership({
      is_member: true,
      is_inherited: inherited,
      paying_org_id: 'org_paying',
      membership_tier: tier,
    }));
    const checkDeps = deps(['org_1'], resolve);

    await expect(hasActiveMembershipForUser('user_1', checkDeps)).resolves.toBe(true);
    expect(checkDeps.invalidateMembershipCache).toHaveBeenCalledWith('org_1');
    expect(resolve).toHaveBeenCalledWith('org_1');
  });

  it('checks every organization instead of trusting the first or primary organization', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership({
        is_member: true,
        paying_org_id: 'org_paid',
        membership_tier: 'individual_academic',
      }));

    await expect(
      hasActiveMembershipForUser('user_1', deps(['org_free', 'org_paid'], resolve)),
    ).resolves.toBe(true);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(1, 'org_free');
    expect(resolve).toHaveBeenNthCalledWith(2, 'org_paid');
  });

  it('fails closed when organization lookup or effective-membership resolution fails', async () => {
    const listFailure: ActiveMembershipCheckDeps = {
      listOrganizationIdsForUser: vi.fn().mockRejectedValue(new Error('database unavailable')),
      invalidateMembershipCache: vi.fn(),
      resolveEffectiveMembership: vi.fn(),
    };
    const resolverFailure = deps(
      ['org_1'],
      vi.fn().mockRejectedValue(new Error('resolver unavailable')),
    );

    await expect(hasActiveMembershipForUser('user_1', listFailure)).resolves.toBe(false);
    await expect(hasActiveMembershipForUser('user_1', resolverFailure)).resolves.toBe(false);
  });
});
