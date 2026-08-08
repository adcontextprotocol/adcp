import { describe, it, expect, vi } from 'vitest';
import {
  API_ACCESS_TIERS,
  ACTIVE_SUBSCRIPTION_STATUSES,
  isApiAccessTier,
  isActiveSubscriptionStatus,
  tierLabel,
  resolveOwnerMembership,
  isContentSubmissionMembershipEligible,
  checkContentSubmissionTier,
  type CheckContentSubmissionTierDeps,
} from '../../src/services/membership-tiers.js';

describe('membership-tiers', () => {
  describe('API_ACCESS_TIERS', () => {
    it('matches the canonical heartbeat tier list', () => {
      // If this test fails, server/src/addie/jobs/compliance-heartbeat.ts
      // is also broken — they read from the same constant. Keep this test
      // as the contract: changing API access requires changing the constant.
      expect(API_ACCESS_TIERS).toEqual([
        'individual_professional',
        'company_standard',
        'company_icl',
        'company_leader',
      ]);
    });

    it('does not include explorer (free tier)', () => {
      expect(API_ACCESS_TIERS).not.toContain('explorer');
    });
  });

  describe('isApiAccessTier', () => {
    it('returns true for every tier in API_ACCESS_TIERS', () => {
      for (const tier of API_ACCESS_TIERS) {
        expect(isApiAccessTier(tier)).toBe(true);
      }
    });

    it('returns false for explorer (free tier)', () => {
      expect(isApiAccessTier('explorer')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isApiAccessTier(null)).toBe(false);
      expect(isApiAccessTier(undefined)).toBe(false);
    });

    it('returns false for unknown future tiers', () => {
      expect(isApiAccessTier('company_galactic')).toBe(false);
    });
  });

  describe('isActiveSubscriptionStatus', () => {
    it('accepts active, past_due, trialing — past_due intentionally counts as eligible', () => {
      expect(isActiveSubscriptionStatus('active')).toBe(true);
      expect(isActiveSubscriptionStatus('past_due')).toBe(true);
      expect(isActiveSubscriptionStatus('trialing')).toBe(true);
    });

    it('rejects canceled, unpaid, incomplete', () => {
      expect(isActiveSubscriptionStatus('canceled')).toBe(false);
      expect(isActiveSubscriptionStatus('unpaid')).toBe(false);
      expect(isActiveSubscriptionStatus('incomplete')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isActiveSubscriptionStatus(null)).toBe(false);
      expect(isActiveSubscriptionStatus(undefined)).toBe(false);
    });
  });

  describe('tierLabel', () => {
    it('returns human-readable labels for known tiers', () => {
      expect(tierLabel('explorer')).toBe('Explorer');
      expect(tierLabel('individual_professional')).toBe('Professional');
      expect(tierLabel('company_standard')).toBe('Builder');
      expect(tierLabel('company_icl')).toBe('Partner');
      expect(tierLabel('company_leader')).toBe('Leader');
    });

    it('falls back to the raw enum for unknown tiers (forward-compat)', () => {
      expect(tierLabel('company_galactic')).toBe('company_galactic');
    });

    it('returns null for null/undefined', () => {
      expect(tierLabel(null)).toBeNull();
      expect(tierLabel(undefined)).toBeNull();
    });
  });

  it('subscription statuses match the heartbeat query', () => {
    expect(ACTIVE_SUBSCRIPTION_STATUSES).toEqual(['active', 'past_due', 'trialing']);
  });

  describe('Perspectives content submission eligibility', () => {
    const directMembership = (
      subscription_status: string | null,
      subscription_canceled_at: Date | null = null,
      membership_tier = 'company_standard',
    ) => ({ membership_tier, subscription_status, subscription_canceled_at });

    it.each(['active', 'past_due', 'trialing'])(
      'allows an uncanceled API-access tier with %s status',
      (status) => {
        expect(isContentSubmissionMembershipEligible(directMembership(status))).toBe(true);
      },
    );

    it('rejects canceled, inactive, and non-API direct memberships', () => {
      expect(isContentSubmissionMembershipEligible(
        directMembership('active', new Date('2026-01-01')),
      )).toBe(false);
      expect(isContentSubmissionMembershipEligible(directMembership('unpaid'))).toBe(false);
      expect(isContentSubmissionMembershipEligible(
        directMembership('active', null, 'explorer'),
      )).toBe(false);
      expect(isContentSubmissionMembershipEligible(null)).toBe(false);
    });

    it('keeps past_due eligibility local to content submission', async () => {
      const deps: CheckContentSubmissionTierDeps = {
        resolvePrimaryOrganization: vi.fn().mockResolvedValue('org_123'),
        fetchDirectMembership: vi.fn().mockResolvedValue(directMembership('past_due')),
        resolveEffectiveMembership: vi.fn().mockResolvedValue({
          is_member: false,
          is_inherited: false,
          paying_org_id: null,
          paying_org_name: null,
          hierarchy_chain: [],
          membership_tier: null,
        }),
      };

      await expect(checkContentSubmissionTier('user_123', deps)).resolves.toBe(true);
      expect(deps.resolveEffectiveMembership).not.toHaveBeenCalled();
    });

    it('preserves strict inherited paid membership as a fallback', async () => {
      const deps: CheckContentSubmissionTierDeps = {
        resolvePrimaryOrganization: vi.fn().mockResolvedValue('org_child'),
        fetchDirectMembership: vi.fn().mockResolvedValue(null),
        resolveEffectiveMembership: vi.fn().mockResolvedValue({
          is_member: true,
          is_inherited: true,
          paying_org_id: 'org_parent',
          paying_org_name: 'Parent company',
          hierarchy_chain: ['child.example', 'parent.example'],
          membership_tier: 'company_standard',
        }),
      };

      await expect(checkContentSubmissionTier('user_123', deps)).resolves.toBe(true);
    });
  });

  describe('resolveOwnerMembership — security boundary', () => {
    const EMPTY = {
      is_owner: false,
      membership_tier: null,
      membership_tier_label: null,
      subscription_status: null,
      is_api_access_tier: false,
    };

    it('returns empty shape for anonymous (no userId)', async () => {
      const resolveOwnerOrgId = vi.fn();
      const fetchOrgMembership = vi.fn();
      const result = await resolveOwnerMembership(undefined, 'https://agent.example.com', {
        resolveOwnerOrgId,
        fetchOrgMembership,
      });
      expect(result).toEqual(EMPTY);
      expect(resolveOwnerOrgId).not.toHaveBeenCalled();
      expect(fetchOrgMembership).not.toHaveBeenCalled();
    });

    it('returns empty shape when user is not the owner (resolveOwnerOrgId returns null)', async () => {
      const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => null,
        fetchOrgMembership: async () => {
          throw new Error('should not be called when user is not the owner');
        },
      });
      expect(result).toEqual(EMPTY);
    });

    it('populates the full shape when user owns the agent and the org is API-access', async () => {
      const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => 'org_abc',
        fetchOrgMembership: async () => ({ membership_tier: 'company_standard', subscription_status: 'active' }),
      });
      expect(result).toEqual({
        is_owner: true,
        membership_tier: 'company_standard',
        membership_tier_label: 'Builder',
        subscription_status: 'active',
        is_api_access_tier: true,
      });
    });

    it('reports is_api_access_tier=false when owner is on a non-API tier', async () => {
      const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => 'org_abc',
        fetchOrgMembership: async () => ({ membership_tier: 'explorer', subscription_status: 'active' }),
      });
      expect(result.membership_tier).toBe('explorer');
      expect(result.membership_tier_label).toBe('Explorer');
      expect(result.is_api_access_tier).toBe(false);
    });

    it('reports is_api_access_tier=false when owner subscription is canceled', async () => {
      const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => 'org_abc',
        fetchOrgMembership: async () => ({ membership_tier: 'company_standard', subscription_status: 'canceled' }),
      });
      expect(result.is_api_access_tier).toBe(false);
    });

    it('past_due is intentionally still eligible (Stripe grace window)', async () => {
      const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => 'org_abc',
        fetchOrgMembership: async () => ({ membership_tier: 'company_icl', subscription_status: 'past_due' }),
      });
      expect(result.is_api_access_tier).toBe(true);
    });

    it('returns empty shape when org row is missing (hard delete with dangling member_profile)', async () => {
      // This is the security review's finding #4: a deleted org should NOT
      // produce a tier:null/eligible:false response that looks like a
      // logged-in owner of a downgraded org. Treat as ownership failure.
      const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => 'org_deleted',
        fetchOrgMembership: async () => null,
      });
      expect(result).toEqual(EMPTY);
    });

    it('shape is identical for non-owner and missing-org-row cases (no side-channel)', async () => {
      // Non-owners and orphaned member-profile owners must see the exact
      // same response shape, so an attacker can't infer "this user has a
      // dangling profile pointing at a deleted org" from response keys.
      const nonOwner = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => null,
        fetchOrgMembership: async () => {
          throw new Error('should not be called');
        },
      });
      const orphanOwner = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
        resolveOwnerOrgId: async () => 'org_deleted',
        fetchOrgMembership: async () => null,
      });
      expect(nonOwner).toEqual(orphanOwner);
    });

    describe('is_owner field — load-bearing gate for verdict_source on the public API', () => {
      // verdict_source on /api/registry/agents/:url/compliance is gated on
      // ownerMembership.is_owner (not on is_api_access_tier — that would be
      // too narrow and hide the UX cue from free-tier owners). These tests
      // pin the is_owner semantics so a future refactor can't silently break
      // the gate. Issue #4378.

      it('is_owner is false for anonymous (no userId)', async () => {
        const result = await resolveOwnerMembership(undefined, 'https://agent.example.com', {
          resolveOwnerOrgId: async () => 'irrelevant',
          fetchOrgMembership: async () => ({ membership_tier: 'company_standard', subscription_status: 'active' }),
        });
        expect(result.is_owner).toBe(false);
      });

      it('is_owner is false when the user is not a member of any owning org', async () => {
        const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
          resolveOwnerOrgId: async () => null,
          fetchOrgMembership: async () => ({ membership_tier: 'company_standard', subscription_status: 'active' }),
        });
        expect(result.is_owner).toBe(false);
      });

      it('is_owner is false when the resolved org has been deleted (orphan profile)', async () => {
        const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
          resolveOwnerOrgId: async () => 'org_deleted',
          fetchOrgMembership: async () => null,
        });
        expect(result.is_owner).toBe(false);
      });

      it('is_owner is true for an actual owner regardless of tier — Explorer (free)', async () => {
        const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
          resolveOwnerOrgId: async () => 'org_abc',
          fetchOrgMembership: async () => ({ membership_tier: 'explorer', subscription_status: 'active' }),
        });
        expect(result.is_owner).toBe(true);
        // is_owner is broader than is_api_access_tier: free-tier owners
        // still get verdict_source on their own dashboard view.
        expect(result.is_api_access_tier).toBe(false);
      });

      it('is_owner is true for an actual owner — API-access tier with active sub', async () => {
        const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
          resolveOwnerOrgId: async () => 'org_abc',
          fetchOrgMembership: async () => ({ membership_tier: 'company_icl', subscription_status: 'active' }),
        });
        expect(result.is_owner).toBe(true);
        expect(result.is_api_access_tier).toBe(true);
      });

      it('is_owner is true even when subscription is canceled (ownership ≠ entitlement)', async () => {
        const result = await resolveOwnerMembership('user_123', 'https://agent.example.com', {
          resolveOwnerOrgId: async () => 'org_abc',
          fetchOrgMembership: async () => ({ membership_tier: 'company_standard', subscription_status: 'canceled' }),
        });
        expect(result.is_owner).toBe(true);
        expect(result.is_api_access_tier).toBe(false);
        // The canceled-sub owner still sees their own verdict_source on the
        // dashboard — they just can't earn badges until they reactivate.
      });
    });
  });
});
