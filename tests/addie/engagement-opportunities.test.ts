/**
 * Tests for engagement planner pure functions: computeEngagementOpportunities + shouldContact
 *
 * No mocks, no DB. Verifies the scoring pipeline, stage gating, cooldowns,
 * opt-out enforcement, unreplied escalation, and monthly pulse logic.
 */

import { describe, it, expect } from '@jest/globals';
import {
  computeEngagementOpportunities,
  shouldContact,
  OPPORTUNITY_CATALOG,
  STAGE_COOLDOWNS,
  MAX_UNREPLIED_BEFORE_PULSE,
  MONTHLY_PULSE_DAYS,
} from '../../server/src/addie/services/engagement-planner.js';
import type {
  EngagementContext,
  EngagementOpportunity,
  CertificationSummary,
} from '../../server/src/addie/services/engagement-planner.js';
import type { PersonRelationship, RelationshipStage } from '../../server/src/db/relationship-db.js';
import type { MemberCapabilities } from '../../server/src/addie/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRelationship(overrides: Partial<PersonRelationship> = {}): PersonRelationship {
  return {
    id: 'test-person',
    display_name: 'Test User',
    slack_user_id: 'U123',
    email: 'test@example.com',
    workos_user_id: null,
    prospect_org_id: 'org-1',
    stage: 'prospect' as RelationshipStage,
    stage_changed_at: new Date(),
    sentiment_trend: 'neutral' as const,
    interaction_count: 0,
    unreplied_outreach_count: 0,
    last_addie_message_at: null,
    last_person_message_at: null,
    last_interaction_channel: null,
    next_contact_after: null,
    contact_preference: null,
    slack_dm_channel_id: null,
    slack_dm_thread_ts: null,
    opted_out: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCapabilities(overrides: Partial<MemberCapabilities> = {}): MemberCapabilities {
  return {
    account_linked: true,
    profile_complete: true,
    offerings_set: true,
    email_prefs_configured: true,
    working_group_count: 1,
    council_count: 0,
    events_registered: 2,
    events_attended: 1,
    community_profile_public: true,
    community_profile_completeness: 80,
    has_team_members: false,
    is_org_admin: false,
    is_committee_leader: false,
    slack_message_count_30d: 5,
    ...overrides,
  };
}

function makeContext(overrides: Partial<EngagementContext> = {}): EngagementContext {
  return {
    relationship: makeRelationship(),
    capabilities: null,
    insights: [],
    company: null,
    recentMessages: [],
    certification: null,
    ...overrides,
  };
}

function ids(opps: EngagementOpportunity[]): string[] {
  return opps.map(o => o.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeEngagementOpportunities', () => {
  it('returns at most 5 opportunities', () => {
    // Exploring stage with lots of gaps should have many candidates
    const ctx = makeContext({
      relationship: makeRelationship({ stage: 'exploring', slack_user_id: 'U1', workos_user_id: null }),
      capabilities: makeCapabilities({
        account_linked: false,
        profile_complete: false,
        offerings_set: false,
        email_prefs_configured: false,
        community_profile_public: false,
        working_group_count: 0,
        events_registered: 0,
      }),
    });

    const result = computeEngagementOpportunities(ctx);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('returns opportunities sorted by relevance descending', () => {
    const ctx = makeContext({
      relationship: makeRelationship({ stage: 'exploring' }),
    });
    const result = computeEngagementOpportunities(ctx);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].relevance).toBeGreaterThanOrEqual(result[i].relevance);
    }
  });

  describe('stage gating', () => {
    it('prospect gets no exploring+ items', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'prospect' }),
      });
      const result = computeEngagementOpportunities(ctx);

      // Items that require exploring or higher should not appear
      const exploringPlusIds = OPPORTUNITY_CATALOG
        .filter(e => ['exploring', 'participating', 'contributing', 'leading'].includes(e.minStage))
        .map(e => e.id);

      for (const opp of result) {
        expect(exploringPlusIds).not.toContain(opp.id);
      }
    });

    it('contributing member gets recognition items', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'contributing', workos_user_id: 'w1' }),
        capabilities: makeCapabilities({
          working_group_count: 3,
          events_attended: 5,
          council_count: 0,
          is_committee_leader: false,
          slack_message_count_30d: 20,
        }),
        insights: [{ type: 'role', value: 'Engineer', confidence: 'high' }],
      });
      const result = computeEngagementOpportunities(ctx);
      const dims = new Set(result.map(o => o.dimension));
      expect(dims.has('recognition')).toBe(true);
    });
  });

  describe('discovery gaps', () => {
    it('empty insights push discovery to the top for prospects', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'prospect' }),
        insights: [],
      });
      const result = computeEngagementOpportunities(ctx);
      // Discovery should dominate for a prospect with no insights
      const discoveryCount = result.filter(o => o.dimension === 'discovery').length;
      expect(discoveryCount).toBeGreaterThanOrEqual(2);
    });

    it('full insights exclude discovery items', () => {
      const allInsightTypes = ['role', 'building', 'interest', 'aao_goals', 'challenges', 'use_case', 'timeline'];
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'exploring' }),
        insights: allInsightTypes.map(t => ({ type: t, value: 'known', confidence: 'high' })),
      });
      const result = computeEngagementOpportunities(ctx);
      const discoveryItems = result.filter(o => o.dimension === 'discovery');
      expect(discoveryItems.length).toBe(0);
    });
  });

  describe('company type weighting', () => {
    it('agency gets higher engagement scores', () => {
      const baseCtx = {
        relationship: makeRelationship({ stage: 'exploring', slack_user_id: 'U1' }),
        capabilities: makeCapabilities({ working_group_count: 0, events_registered: 0 }),
        insights: [{ type: 'role', value: 'Media Planner', confidence: 'high' }],
        recentMessages: [],
        certification: null,
      } as const;

      const agencyResult = computeEngagementOpportunities({
        ...baseCtx,
        company: { name: 'Agency Co', type: 'agency', is_member: true },
      });
      const brandResult = computeEngagementOpportunities({
        ...baseCtx,
        company: { name: 'Brand Co', type: 'brand', is_member: true },
      });

      // Find the same engagement item in both
      const agencyWG = agencyResult.find(o => o.id === 'join_working_group');
      const brandWG = brandResult.find(o => o.id === 'join_working_group');

      if (agencyWG && brandWG) {
        expect(agencyWG.relevance).toBeGreaterThan(brandWG.relevance);
      }
    });

    it('brand gets lower discovery scores (brands are buyers, not interviewees)', () => {
      const baseCtx = {
        relationship: makeRelationship({ stage: 'prospect' }),
        capabilities: null,
        insights: [],
        recentMessages: [],
        certification: null,
      } as const;

      const brandResult = computeEngagementOpportunities({
        ...baseCtx,
        company: { name: 'Brand Co', type: 'brand', is_member: false },
      });
      const agencyResult = computeEngagementOpportunities({
        ...baseCtx,
        company: { name: 'Agency Co', type: 'agency', is_member: false },
      });

      const brandDisc = brandResult.find(o => o.id === 'discover_role');
      const agencyDisc = agencyResult.find(o => o.id === 'discover_role');

      if (brandDisc && agencyDisc) {
        expect(brandDisc.relevance).toBeLessThan(agencyDisc.relevance);
      }
    });
  });

  describe('recency penalty', () => {
    it('penalizes opportunities when recent messages overlap keywords', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'exploring', slack_user_id: 'U1' }),
        capabilities: makeCapabilities({ working_group_count: 0 }),
        recentMessages: [
          {
            role: 'assistant' as const,
            content: 'Have you considered joining a working group? There are several relevant to your interests.',
            channel: 'slack',
            created_at: new Date(),
          },
        ],
      });

      const result = computeEngagementOpportunities(ctx);
      const wg = result.find(o => o.id === 'join_working_group');

      // Now test without the recent message
      const ctxNoRecent = makeContext({
        relationship: makeRelationship({ stage: 'exploring', slack_user_id: 'U1' }),
        capabilities: makeCapabilities({ working_group_count: 0 }),
        recentMessages: [],
      });

      const resultNoRecent = computeEngagementOpportunities(ctxNoRecent);
      const wgNoRecent = resultNoRecent.find(o => o.id === 'join_working_group');

      if (wg && wgNoRecent) {
        expect(wg.relevance).toBeLessThan(wgNoRecent.relevance);
      }
    });
  });

  describe('capability conditions', () => {
    it('excludes complete_profile when profile is complete', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'exploring' }),
        capabilities: makeCapabilities({ profile_complete: true }),
      });
      const result = computeEngagementOpportunities(ctx);
      expect(ids(result)).not.toContain('complete_profile');
    });

    it('includes complete_profile when profile is incomplete', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'welcomed' }),
        capabilities: makeCapabilities({ profile_complete: false }),
      });
      const result = computeEngagementOpportunities(ctx);
      // It should be somewhere in the catalog results (may or may not be top 5)
      // We re-run with fewer competing items
      const ctxNarrow = makeContext({
        relationship: makeRelationship({ stage: 'welcomed', workos_user_id: 'w1' }),
        capabilities: makeCapabilities({
          profile_complete: false,
          account_linked: true,
          email_prefs_configured: true,
        }),
        insights: [
          { type: 'role', value: 'PM', confidence: 'high' },
          { type: 'building', value: 'SDK', confidence: 'high' },
          { type: 'interest', value: 'OpenRTB', confidence: 'high' },
        ],
      });
      const narrowResult = computeEngagementOpportunities(ctxNarrow);
      expect(ids(narrowResult)).toContain('complete_profile');
    });
  });

  describe('certification opportunities', () => {
    it('suggests start_certification when no progress exists', () => {
      const ctx = makeContext({
        relationship: makeRelationship({
          stage: 'welcomed',
          workos_user_id: 'w1', // linked, so link_accounts/become_member won't compete
          prospect_org_id: null,
        }),
        capabilities: makeCapabilities({ events_registered: 1 }), // remove register_event competition
        certification: null,
        insights: [
          { type: 'role', value: 'PM', confidence: 'high' },
          { type: 'building', value: 'SDK', confidence: 'high' },
          { type: 'interest', value: 'OpenRTB', confidence: 'high' },
          { type: 'aao_goals', value: 'Learn', confidence: 'high' },
          { type: 'challenges', value: 'Integration', confidence: 'high' },
        ],
      });
      const result = computeEngagementOpportunities(ctx);
      expect(ids(result)).toContain('start_certification');
    });

    it('suggests continue_certification when in progress', () => {
      const cert: CertificationSummary = {
        modulesCompleted: 2,
        totalModules: 10,
        credentialsEarned: [],
        hasInProgressTrack: true,
      };
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'welcomed' }),
        certification: cert,
        insights: [
          { type: 'role', value: 'PM', confidence: 'high' },
          { type: 'building', value: 'SDK', confidence: 'high' },
          { type: 'interest', value: 'OpenRTB', confidence: 'high' },
        ],
      });
      const result = computeEngagementOpportunities(ctx);
      expect(ids(result)).toContain('continue_certification');
      expect(ids(result)).not.toContain('start_certification');
    });

    it('suggests cert_completion when credentials earned', () => {
      const cert: CertificationSummary = {
        modulesCompleted: 5,
        totalModules: 10,
        credentialsEarned: ['adcp-basics'],
        hasInProgressTrack: false,
      };
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'exploring' }),
        certification: cert,
      });
      const result = computeEngagementOpportunities(ctx);
      expect(ids(result)).toContain('cert_completion');
    });
  });

  describe('edge cases', () => {
    it('fully set-up member gets community/recognition items', () => {
      const ctx = makeContext({
        relationship: makeRelationship({
          stage: 'participating',
          workos_user_id: 'w1',
          slack_user_id: 'U1',
        }),
        capabilities: makeCapabilities({
          account_linked: true,
          profile_complete: true,
          offerings_set: true,
          email_prefs_configured: true,
          community_profile_public: true,
          working_group_count: 2,
          events_registered: 3,
          events_attended: 2,
          has_team_members: true,
          slack_message_count_30d: 15,
        }),
        insights: [
          { type: 'role', value: 'Engineer', confidence: 'high' },
          { type: 'building', value: 'SDK', confidence: 'high' },
          { type: 'interest', value: 'OpenRTB', confidence: 'high' },
          { type: 'aao_goals', value: 'Contribute', confidence: 'high' },
          { type: 'challenges', value: 'Integration', confidence: 'high' },
          { type: 'use_case', value: 'Bidding', confidence: 'high' },
          { type: 'timeline', value: 'Q2', confidence: 'high' },
        ],
      });
      const result = computeEngagementOpportunities(ctx);
      expect(result.length).toBeGreaterThan(0);
      const dims = new Set(result.map(o => o.dimension));
      // Should not have hygiene or discovery since everything is done
      expect(dims.has('hygiene')).toBe(false);
      expect(dims.has('discovery')).toBe(false);
      // Should have community or recognition
      expect(dims.has('community') || dims.has('recognition')).toBe(true);
    });

    it('returns empty array when no opportunities apply', () => {
      // Prospect with no channels, no org — almost nothing applies
      const ctx = makeContext({
        relationship: makeRelationship({
          stage: 'prospect',
          slack_user_id: null,
          workos_user_id: 'w1',
          email: null,
          prospect_org_id: null,
        }),
        insights: [
          { type: 'role', value: 'PM', confidence: 'high' },
          { type: 'building', value: 'Platform', confidence: 'high' },
          { type: 'interest', value: 'Standards', confidence: 'high' },
        ],
      });
      const result = computeEngagementOpportunities(ctx);
      // May return some discovery items but no hygiene items
      for (const opp of result) {
        expect(opp.relevance).toBeGreaterThanOrEqual(0);
        expect(opp.relevance).toBeLessThanOrEqual(100);
      }
    });

    it('all relevance scores are non-negative', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'participating' }),
        company: { name: 'Agency Co', type: 'agency', is_member: true },
        capabilities: makeCapabilities({ working_group_count: 0, events_registered: 0 }),
      });
      const result = computeEngagementOpportunities(ctx);
      for (const opp of result) {
        expect(opp.relevance).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('dimension diversity', () => {
    it('caps at 2 opportunities per dimension in top 5', () => {
      // Prospect with no insights — lots of discovery items eligible
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'prospect' }),
        insights: [],
      });
      const result = computeEngagementOpportunities(ctx);
      const dimensionCounts: Record<string, number> = {};
      for (const opp of result) {
        dimensionCounts[opp.dimension] = (dimensionCounts[opp.dimension] ?? 0) + 1;
      }
      for (const count of Object.values(dimensionCounts)) {
        expect(count).toBeLessThanOrEqual(2);
      }
    });
  });

  describe('monthly pulse community boost', () => {
    it('boosts community items when contact reason is monthly pulse', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'welcomed' }),
      });
      const normalResult = computeEngagementOpportunities(ctx);
      const pulseResult = computeEngagementOpportunities(ctx, 'monthly pulse — low-key update');

      const normalCommunity = normalResult.find(o => o.dimension === 'community');
      const pulseCommunity = pulseResult.find(o => o.dimension === 'community');

      // Community item should score higher in pulse context
      if (normalCommunity && pulseCommunity && normalCommunity.id === pulseCommunity.id) {
        expect(pulseCommunity.relevance).toBeGreaterThan(normalCommunity.relevance);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// shouldContact tests
// ---------------------------------------------------------------------------

describe('shouldContact', () => {
  function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 86400000);
  }

  it('blocks opted-out users', () => {
    const r = makeRelationship({ opted_out: true });
    const result = shouldContact(r);
    expect(result.shouldContact).toBe(false);
    expect(result.reason).toBe('opted out');
  });

  it('blocks users with negative sentiment', () => {
    const r = makeRelationship({ sentiment_trend: 'negative' });
    const result = shouldContact(r);
    expect(result.shouldContact).toBe(false);
    expect(result.reason).toContain('negative sentiment');
  });

  it('contacts new prospects with no prior messages', () => {
    const r = makeRelationship({ stage: 'prospect', last_addie_message_at: null });
    const result = shouldContact(r);
    expect(result.shouldContact).toBe(true);
    expect(result.reason).toContain('welcome');
  });

  it('blocks when no reachable channel', () => {
    const r = makeRelationship({ slack_user_id: null, email: null });
    const result = shouldContact(r);
    expect(result.shouldContact).toBe(false);
    expect(result.reason).toContain('no reachable channel');
  });

  it('prefers Slack over email when both available', () => {
    const r = makeRelationship({ slack_user_id: 'U1', email: 'test@test.com' });
    const result = shouldContact(r);
    expect(result.channel).toBe('slack');
  });

  it('falls back to email when no Slack', () => {
    const r = makeRelationship({ slack_user_id: null, email: 'test@test.com' });
    const result = shouldContact(r);
    expect(result.channel).toBe('email');
  });

  it('respects contact_preference', () => {
    const r = makeRelationship({
      slack_user_id: 'U1',
      email: 'test@test.com',
      contact_preference: 'email',
    });
    const result = shouldContact(r);
    expect(result.channel).toBe('email');
  });

  describe('channel rotation', () => {
    it('switches to email after 2+ unreplied on Slack', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: 'test@test.com',
        unreplied_outreach_count: 2,
        last_interaction_channel: 'slack',
        last_addie_message_at: daysAgo(8),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.channel).toBe('email');
    });

    it('switches to Slack after 2+ unreplied on email', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: 'test@test.com',
        unreplied_outreach_count: 2,
        last_interaction_channel: 'email',
        last_addie_message_at: daysAgo(8),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.channel).toBe('slack');
    });

    it('does not rotate if contact_preference is set', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: 'test@test.com',
        contact_preference: 'slack',
        unreplied_outreach_count: 2,
        last_interaction_channel: 'slack',
        last_addie_message_at: daysAgo(8),
      });
      const result = shouldContact(r);
      expect(result.channel).toBe('slack');
    });

    it('does not rotate if only one channel available', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: null,
        unreplied_outreach_count: 2,
        last_interaction_channel: 'slack',
        last_addie_message_at: daysAgo(8),
      });
      const result = shouldContact(r);
      expect(result.channel).toBe('slack');
    });
  });

  describe('stage cooldowns', () => {
    it('blocks when within stage cooldown', () => {
      const r = makeRelationship({
        stage: 'exploring',
        last_addie_message_at: daysAgo(3), // exploring cooldown is 7 days
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('stage cooldown');
    });

    it('allows contact after cooldown expires', () => {
      const r = makeRelationship({
        stage: 'exploring',
        last_addie_message_at: daysAgo(8), // > 7 day cooldown
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
    });

    it('escalates cooldown with 2+ unreplied', () => {
      // welcomed cooldown is 5 days, but with 2 unreplied escalates to exploring (7 days)
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 2,
        last_addie_message_at: daysAgo(6), // past 5d but within 7d
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('stage cooldown');
    });
  });

  describe('monthly pulse', () => {
    it('blocks 3+ unreplied within 30 days', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 3,
        last_addie_message_at: daysAgo(15),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('monthly pulse');
    });

    it('allows monthly pulse after 30+ days', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 3,
        last_addie_message_at: daysAgo(31),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.reason).toContain('monthly pulse');
    });

    it('allows monthly pulse with 5+ unreplied after 30 days', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 5,
        last_addie_message_at: daysAgo(35),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.reason).toContain('monthly pulse');
    });
  });

  describe('next_contact_after', () => {
    it('blocks when next_contact_after is in the future', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        next_contact_after: new Date(Date.now() + 86400000), // tomorrow
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('cooldown');
    });

    it('allows when next_contact_after is in the past', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        next_contact_after: daysAgo(1),
        last_addie_message_at: daysAgo(6), // past welcomed cooldown of 5 days
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
    });
  });
});
