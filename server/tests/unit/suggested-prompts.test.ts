import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSuggestedPrompts, pickPrompts } from '../../src/addie/home/builders/suggested-prompts.js';
import { matchRuleIdFromMessage, ALL_RULES } from '../../src/addie/home/builders/rules/prompt-rules.js';
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

    it('shows List my company in the directory for non-personal owners without a public listing', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 3, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: false, team_wg_coverage: 0.6 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('List my company in the directory');
    });

    it('also shows the listing prompt for org admins (not just owners)', () => {
      const ctx = makeMember({
        org_membership: { role: 'admin', member_count: 3, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: false, team_wg_coverage: 0.6 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('List my company in the directory');
    });

    it('does not show the listing prompt for plain members', () => {
      const ctx = makeMember({
        org_membership: { role: 'member', member_count: 3, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: false, team_wg_coverage: 0.6 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('List my company in the directory');
    });

    it('does not show listing prompt when listing already public', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 3, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: true, team_wg_coverage: 0.6 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('List my company in the directory');
    });

    it('does not show listing prompt for personal orgs', () => {
      const ctx = makeMember({
        organization: {
          workos_organization_id: 'org_123',
          name: 'Acme',
          subscription_status: 'active',
          is_personal: true,
          membership_tier: 'individual_professional',
        },
        org_membership: { role: 'owner', member_count: 1, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: false, team_wg_coverage: 0 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('List my company in the directory');
    });

    it('shows Find working groups for my team when coverage is below 50% and team >= 3', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 4, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: true, team_wg_coverage: 0.2 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Find working groups for my team');
    });

    it('does not show team WG prompt when coverage is healthy (≥ 50%)', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 8, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: true, team_wg_coverage: 0.6 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Find working groups for my team');
    });

    it('does not show team WG prompt for tiny teams (< 3)', () => {
      const ctx = makeMember({
        org_membership: { role: 'owner', member_count: 2, joined_at: DAYS_AGO(60) },
        adoption: { has_company_listing: true, team_wg_coverage: 0 },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Find working groups for my team');
    });
  });

  describe('certification continuation', () => {
    it('shows Continue certification when a fresh attempt is in_progress', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A',
          module_id: 'A1',
          status: 'in_progress',
          started_at: DAYS_AGO(7),
          last_activity_at: DAYS_AGO(2),
        },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Continue A1');
    });

    it('does not show the cert prompt when the latest attempt is passed', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A',
          module_id: 'A1',
          status: 'passed',
          started_at: DAYS_AGO(30),
          last_activity_at: DAYS_AGO(20),
        },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Continue A1');
    });

    it('does not show the cert prompt when the latest attempt is failed', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A',
          module_id: 'A1',
          status: 'failed',
          started_at: DAYS_AGO(30),
          last_activity_at: DAYS_AGO(20),
        },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Continue A1');
    });

    it('does not show the cert prompt when there is no attempt', () => {
      const ctx = makeMember({ certification: undefined });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Continue A1');
    });

    it('does not show the cert prompt when the attempt is older than 45 days (stale)', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A',
          module_id: 'A1',
          status: 'in_progress',
          started_at: DAYS_AGO(60),
          last_activity_at: DAYS_AGO(60),
        },
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Continue A1');
    });

    it('cert continuation outranks profile completeness', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A', module_id: 'A1', status: 'in_progress',
          started_at: DAYS_AGO(7), last_activity_at: DAYS_AGO(2),
        },
        community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      const certIdx = labels.indexOf('Continue A1');
      const profileIdx = labels.indexOf('Complete my profile');
      expect(certIdx).toBeGreaterThanOrEqual(0);
      expect(profileIdx).toBeGreaterThanOrEqual(0);
      expect(certIdx).toBeLessThan(profileIdx);
    });

    it('cert continuation outranks lapsed re-engagement (concrete unfinished thing wins)', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A', module_id: 'A1', status: 'in_progress',
          started_at: DAYS_AGO(7), last_activity_at: DAYS_AGO(2),
        },
        engagement: { login_count_30d: 0, last_login: DAYS_AGO(60), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      const certIdx = labels.indexOf('Continue A1');
      const lapsedIdx = labels.indexOf("What's new since you were last here?");
      expect(certIdx).toBeGreaterThanOrEqual(0);
      expect(lapsedIdx).toBeGreaterThanOrEqual(0);
      expect(certIdx).toBeLessThan(lapsedIdx);
    });

    it('suppresses Start with the Academy persona prompt when learner is mid-cert', () => {
      const ctx = makeMember({
        persona: { persona: 'ladder_climber', aspiration_persona: null, source: 'assessment', journey_stage: null },
        certification: {
          track_id: 'A', module_id: 'A1', status: 'in_progress',
          started_at: DAYS_AGO(7), last_activity_at: DAYS_AGO(2),
        },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      expect(labels).toContain('Continue A1');
      expect(labels).not.toContain('Start with the Academy');
    });

    it('still shows Start with the Academy when ladder_climber has no in-progress cert', () => {
      const ctx = makeMember({
        persona: { persona: 'ladder_climber', aspiration_persona: null, source: 'assessment', journey_stage: null },
        certification: undefined,
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Start with the Academy');
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

  describe('suppression via prompt_telemetry', () => {
    it('suppresses a rule whose suppressed_until is in the future', () => {
      const ctx = makeMember({
        community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
        prompt_telemetry: new Map([
          ['profile.incomplete', {
            shown_count: 5,
            last_shown_at: DAYS_AGO(1),
            suppressed_until: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
          }],
        ]),
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).not.toContain('Complete my profile');
    });

    it('does not suppress a rule whose suppressed_until is in the past', () => {
      const ctx = makeMember({
        community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
        prompt_telemetry: new Map([
          ['profile.incomplete', {
            shown_count: 5,
            last_shown_at: DAYS_AGO(60),
            suppressed_until: DAYS_AGO(1),
          }],
        ]),
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Complete my profile');
    });

    it('does not suppress when telemetry is missing', () => {
      const ctx = makeMember({
        community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
        prompt_telemetry: undefined,
      });
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Complete my profile');
    });

    it('does not suppress persona prompts even with high shown_count', () => {
      const ctx = makeMember({
        persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
        prompt_telemetry: new Map([
          ['persona.data_decoder', {
            shown_count: 100,
            last_shown_at: DAYS_AGO(1),
            suppressed_until: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
          }],
        ]),
      });
      // Persona rules have decay: false, so suppressed_until is ignored.
      expect(buildSuggestedPrompts(ctx, false).map((p) => p.label)).toContain('Prove the outcomes');
    });

    it('persona ruleIds are excluded from telemetry recording', () => {
      const ctx = makeMember({
        persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
      });
      const { ruleIds } = pickPrompts(ctx, false);
      expect(ruleIds.every((id) => !id.startsWith('persona.'))).toBe(true);
    });

    it('suppression of a high-priority rule lets the next-priority rule fire', () => {
      const ctx = makeMember({
        community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
        working_groups: [],
        prompt_telemetry: new Map([
          ['profile.incomplete', {
            shown_count: 5,
            last_shown_at: DAYS_AGO(1),
            suppressed_until: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
          }],
        ]),
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      expect(labels).not.toContain('Complete my profile');
      // Find a working group fires once profile is suppressed.
      expect(labels).toContain('Find a working group');
    });
  });

  describe('pickPrompts', () => {
    it('returns parallel prompts and ruleIds arrays', () => {
      const { prompts, ruleIds } = pickPrompts(makeMember(), false);
      expect(prompts).toHaveLength(ruleIds.length);
      ruleIds.forEach((id) => expect(typeof id).toBe('string'));
    });

    it('admin path returns admin rule IDs', () => {
      const { ruleIds } = pickPrompts(makeMember(), true);
      expect(ruleIds.every((id) => id.startsWith('admin.'))).toBe(true);
    });
  });

  describe('matchRuleIdFromMessage (heuristic click detection)', () => {
    it('matches a known static prompt verbatim', () => {
      const fallback = ALL_RULES.find((r) => r.id === 'fallback.whats_new')!;
      expect(typeof fallback.prompt).toBe('string');
      expect(matchRuleIdFromMessage(fallback.prompt as string)).toBe('fallback.whats_new');
    });

    it('matches with surrounding whitespace trimmed', () => {
      const fallback = ALL_RULES.find((r) => r.id === 'fallback.whats_new')!;
      expect(matchRuleIdFromMessage('  ' + fallback.prompt + '  \n')).toBe('fallback.whats_new');
    });

    it('returns null for an unrelated message', () => {
      expect(matchRuleIdFromMessage('hi can you help me with my agent')).toBeNull();
    });

    it('returns null for empty / null / undefined input', () => {
      expect(matchRuleIdFromMessage(null)).toBeNull();
      expect(matchRuleIdFromMessage(undefined)).toBeNull();
      expect(matchRuleIdFromMessage('')).toBeNull();
    });

    it('does not match a paraphrase (intentional false-negative)', () => {
      const fallback = ALL_RULES.find((r) => r.id === 'fallback.whats_new')!;
      const paraphrased = (fallback.prompt as string).replace(/\?$/, '!');
      expect(matchRuleIdFromMessage(paraphrased)).toBeNull();
    });

    it('matches the cert continuation rule via its module-specific phrasing', () => {
      expect(matchRuleIdFromMessage("Let's keep going with A1. Where did we leave off?"))
        .toBe('cert.continue_in_progress');
      expect(matchRuleIdFromMessage("Let's keep going with B2. Where did we leave off?"))
        .toBe('cert.continue_in_progress');
    });

    it('matches the cert continuation rule via the generic fallback phrasing', () => {
      expect(matchRuleIdFromMessage('Pick up where I left off in certification.'))
        .toBe('cert.continue_in_progress');
    });

    it('every rule with a static prompt has a unique prompt string', () => {
      const staticPrompts = ALL_RULES
        .filter((r) => typeof r.prompt === 'string')
        .map((r) => r.prompt as string);
      expect(new Set(staticPrompts).size).toBe(staticPrompts.length);
    });
  });

  describe('dynamic prompt rendering', () => {
    it('renders module-specific label when module_id is present', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A', module_id: 'A1', status: 'in_progress',
          started_at: DAYS_AGO(2), last_activity_at: DAYS_AGO(2),
        },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      expect(labels).toContain('Continue A1');
    });

    it('falls back to track_id when module_id is null', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'C', module_id: null, status: 'in_progress',
          started_at: DAYS_AGO(2), last_activity_at: DAYS_AGO(2),
        },
      });
      const labels = buildSuggestedPrompts(ctx, false).map((p) => p.label);
      expect(labels).toContain('Continue C');
    });

    it('renders the module-specific prompt body alongside the label', () => {
      const ctx = makeMember({
        certification: {
          track_id: 'A', module_id: 'A1', status: 'in_progress',
          started_at: DAYS_AGO(2), last_activity_at: DAYS_AGO(2),
        },
      });
      const cert = buildSuggestedPrompts(ctx, false).find((p) => p.label === 'Continue A1');
      expect(cert?.prompt).toBe("Let's keep going with A1. Where did we leave off?");
    });
  });
});
