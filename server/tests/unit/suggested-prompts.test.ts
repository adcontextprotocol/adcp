import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSuggestedPrompts } from '../../src/addie/home/builders/suggested-prompts.js';
import type { MemberContext } from '../../src/addie/member-context.js';

const NOW = new Date('2026-04-23T12:00:00Z');
const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeMember(overrides: Partial<MemberContext> = {}): MemberContext {
  return {
    is_mapped: true,
    is_member: true,
    slack_linked: true,
    workos_user: { workos_user_id: 'user_123', email: 'a@b.co' },
    organization: {
      workos_organization_id: 'org_123',
      name: 'Acme',
      subscription_status: 'active',
      is_personal: false,
      membership_tier: 'company_standard',
    },
    working_groups: [{ name: 'Protocol Dev', is_leader: false }],
    engagement: {
      login_count_30d: 10,
      last_login: DAYS_AGO(1),
      working_group_count: 1,
      email_click_count_30d: 0,
      interest_level: 'high',
    },
    addie_history: { total_interactions: 20, last_interaction_at: DAYS_AGO(1), recent_topics: [] },
    ...overrides,
  } as MemberContext;
}

describe('buildSuggestedPrompts', () => {
  describe('admin', () => {
    it('returns the 4 admin prompts when isAdmin=true', () => {
      const prompts = buildSuggestedPrompts(makeMember(), true);
      expect(prompts.map((p) => p.label)).toEqual([
        'Pending invoices',
        'Look up a company',
        'Prospect pipeline',
        'My working groups',
      ]);
    });

    it('admin path ignores non-admin signals (no persona, no profile rule)', () => {
      const m = makeMember({
        community_profile: { is_public: false, slug: null, completeness: 10, github_username: null },
        persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
      });
      const prompts = buildSuggestedPrompts(m, true);
      expect(prompts.every((p) => !p.label.includes('profile'))).toBe(true);
      expect(prompts.every((p) => !p.label.includes('data'))).toBe(true);
    });
  });

  describe('unlinked', () => {
    it('returns onboarding prompts for an unlinked, non-member user', () => {
      const ctx = { is_mapped: false, is_member: false, slack_linked: false } as MemberContext;
      const prompts = buildSuggestedPrompts(ctx, false);
      const labels = prompts.map((p) => p.label);
      expect(labels).toContain("What's AdCP?");
      expect(labels).toContain('New here');
      expect(labels).toContain('Join AgenticAdvertising.org');
    });

    it('handles a null member context', () => {
      const prompts = buildSuggestedPrompts(null, false);
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts.length).toBeLessThanOrEqual(4);
    });
  });

  describe('linked but not a member', () => {
    it('shows membership options', () => {
      const ctx = makeMember({ is_member: false });
      const prompts = buildSuggestedPrompts(ctx, false);
      expect(prompts.map((p) => p.label)).toContain('Membership options');
    });

    it('does not show member-only prompts', () => {
      const ctx = makeMember({ is_member: false });
      const prompts = buildSuggestedPrompts(ctx, false);
      const labels = prompts.map((p) => p.label);
      expect(labels).not.toContain('Complete my profile');
      expect(labels).not.toContain('Find working groups that match your interests');
    });

    it('still shows the 4 discovery+conversion prompts (not just 2)', () => {
      const ctx = makeMember({ is_member: false });
      const prompts = buildSuggestedPrompts(ctx, false);
      expect(prompts.length).toBe(4);
      const labels = prompts.map((p) => p.label);
      expect(labels).toContain("What's AdCP?");
      expect(labels).toContain('Join AgenticAdvertising.org');
      expect(labels).toContain('Membership options');
    });
  });

  describe('persona prompts', () => {
    const cases: Array<[string, string]> = [
      ['molecule_builder', 'Build a sales agent'],
      ['pragmatic_builder', 'Fastest path to AdCP'],
      ['data_decoder', 'Prove the outcomes'],
      ['resops_integrator', 'Fit AdCP into my stack'],
      ['ladder_climber', 'Start with the Academy'],
      ['simple_starter', 'Start with the Academy'],
      ['pureblood_protector', 'Brand safety controls'],
    ];

    for (const [persona, expectedLabel] of cases) {
      it(`shows the ${expectedLabel} prompt for persona ${persona}`, () => {
        const ctx = makeMember({
          persona: { persona, aspiration_persona: null, source: 'assessment', journey_stage: null },
        });
        const prompts = buildSuggestedPrompts(ctx, false);
        expect(prompts.map((p) => p.label)).toContain(expectedLabel);
      });
    }

    it('persona prompt outranks profile and WG prompts', () => {
      const ctx = makeMember({
        persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
        community_profile: { is_public: false, slug: null, completeness: 10, github_username: null },
        working_groups: [],
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      expect(labels[0]).toBe('Prove the outcomes');
    });
  });

  describe('engagement', () => {
    it('shows the lapsed prompt when last_login is 30–90 days ago', () => {
      const ctx = makeMember({
        engagement: { login_count_30d: 0, last_login: DAYS_AGO(60), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain("What's new since you were last here?");
    });

    it('does not show the lapsed prompt for fully-dormant accounts (>90 days)', () => {
      const ctx = makeMember({
        engagement: { login_count_30d: 0, last_login: DAYS_AGO(120), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain("What's new since you were last here?");
    });

    it('shows the low-login prompt when active but rare', () => {
      const ctx = makeMember({
        engagement: { login_count_30d: 1, last_login: DAYS_AGO(5), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain("Here's what you missed");
    });

    it('does not show low-login when login count is healthy', () => {
      const ctx = makeMember();
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain("Here's what you missed");
    });

    it('suppresses low-login for brand-new members (joined < 14 days ago)', () => {
      const ctx = makeMember({
        org_membership: { role: 'member', member_count: 1, joined_at: DAYS_AGO(2) },
        engagement: { login_count_30d: 1, last_login: DAYS_AGO(1), working_group_count: 0, email_click_count_30d: 0, interest_level: 'high' },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain("Here's what you missed");
    });

    it('lapsed beats Explorer upgrade in priority order', () => {
      const ctx = makeMember({
        organization: {
          workos_organization_id: 'org_123',
          name: 'Acme',
          subscription_status: 'active',
          is_personal: true,
          membership_tier: 'individual_academic',
        },
        engagement: { login_count_30d: 0, last_login: DAYS_AGO(60), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      const lapsedIdx = labels.indexOf("What's new since you were last here?");
      const upgradeIdx = labels.indexOf('Upgrade for Slack & working group access');
      expect(lapsedIdx).toBeGreaterThanOrEqual(0);
      expect(upgradeIdx).toBeGreaterThanOrEqual(0);
      expect(lapsedIdx).toBeLessThan(upgradeIdx);
    });

    it('lapsed outranks persona (re-engagement first)', () => {
      const ctx = makeMember({
        persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
        engagement: { login_count_30d: 0, last_login: DAYS_AGO(60), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      expect(labels[0]).toBe("What's new since you were last here?");
    });
  });

  describe('tier and ownership', () => {
    it('shows Explorer upgrade for individual_academic tier', () => {
      const ctx = makeMember({
        organization: {
          workos_organization_id: 'org_123',
          name: 'Acme',
          subscription_status: 'active',
          is_personal: true,
          membership_tier: 'individual_academic',
        },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Upgrade for Slack & working group access');
    });

    it('does not show Explorer upgrade for higher tiers', () => {
      const ctx = makeMember({
        organization: {
          workos_organization_id: 'org_123',
          name: 'Acme',
          subscription_status: 'active',
          is_personal: false,
          membership_tier: 'company_leader',
        },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Upgrade for Slack & working group access');
    });

    it('shows Invite your team for solo org owners', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 1, joined_at: DAYS_AGO(30) },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Invite your team');
    });

    it('does not show Invite your team for non-owners', () => {
      const ctx = makeMember({
        org_membership: { role: 'member', member_count: 1, joined_at: DAYS_AGO(30) },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Invite your team');
    });

    it('does not show Invite your team when team already exists', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 8, joined_at: DAYS_AGO(30) },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Invite your team');
    });
  });

  describe('profile and working groups', () => {
    it('shows Complete my profile when completeness < 80', () => {
      const ctx = makeMember({
        community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Complete my profile');
    });

    it('does not show Complete my profile when completeness >= 80', () => {
      const ctx = makeMember({
        community_profile: { is_public: true, slug: 'acme', completeness: 90, github_username: null },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Complete my profile');
    });

    it('shows Find a working group when member has no groups', () => {
      const ctx = makeMember({ working_groups: [] });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Find a working group');
    });

    it('shows Working group to-dos for WG leaders', () => {
      const ctx = makeMember({
        working_groups: [{ name: 'Creative', is_leader: true }],
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Working group to-dos');
    });

    it("shows What's happening in my working groups for non-leader members", () => {
      const ctx = makeMember({
        working_groups: [{ name: 'Creative', is_leader: false }],
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain("What's happening in my working groups?");
    });
  });

  describe('output shape', () => {
    it('returns at most 4 prompts', () => {
      const prompts = buildSuggestedPrompts(makeMember(), false);
      expect(prompts.length).toBeLessThanOrEqual(4);
    });

    it('returns an even number of prompts (for the 2-col grid)', () => {
      const prompts = buildSuggestedPrompts(makeMember(), false);
      expect(prompts.length % 2).toBe(0);
    });

    it('does not return duplicates', () => {
      const prompts = buildSuggestedPrompts(makeMember(), false);
      const labels = prompts.map((p) => p.label);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it('always returns at least the fallback', () => {
      const ctx = makeMember({
        is_member: true,
        community_profile: { is_public: true, slug: 'a', completeness: 100, github_username: null },
        working_groups: [{ name: 'WG', is_leader: false }],
        engagement: { login_count_30d: 10, last_login: DAYS_AGO(1), working_group_count: 1, email_click_count_30d: 0, interest_level: 'high' },
        addie_history: { total_interactions: 100, last_interaction_at: DAYS_AGO(1), recent_topics: [] },
      });
      const prompts = buildSuggestedPrompts(ctx, false);
      expect(prompts.length).toBeGreaterThan(0);
    });
  });
});
