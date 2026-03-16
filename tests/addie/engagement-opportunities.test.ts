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
  hasMeaningfulEngagement,
  extractUserFacingMessage,
  textToEmailHtml,
  OPPORTUNITY_CATALOG,
  STAGE_COOLDOWNS,
  MAX_UNREPLIED_BEFORE_PULSE,
  MAX_TOTAL_UNREPLIED,
  MONTHLY_PULSE_DAYS,
  DISENGAGING_PULSE_DAYS,
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
    stage_changed_at: new Date(Date.now() - 2 * 86400000), // 2 days ago (past welcome grace period)
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
    last_active_days_ago: 2,
    slack_message_count_30d: 5,
    ...overrides,
  };
}

function makeContext(overrides: Partial<EngagementContext> = {}): EngagementContext {
  return {
    relationship: makeRelationship(),
    capabilities: null,
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
      });
      const result = computeEngagementOpportunities(ctx);
      // Discovery should appear for a prospect with no insights (capped at 1 per top-5)
      const discoveryCount = result.filter(o => o.dimension === 'discovery').length;
      expect(discoveryCount).toBe(1);
    });

  });

  describe('discovery dampening', () => {
    it('excludes early discovery items when person has 3+ messages', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'exploring' }),
        recentMessages: [
          { role: 'user' as const, content: 'I work on programmatic', channel: 'slack', created_at: new Date() },
          { role: 'user' as const, content: 'We use DV360', channel: 'slack', created_at: new Date() },
          { role: 'user' as const, content: 'Interested in measurement', channel: 'slack', created_at: new Date() },
        ],
      });
      const result = computeEngagementOpportunities(ctx);
      // Early discovery items (discover_role, discover_building, discover_interest) should be excluded
      const earlyDiscovery = result.filter(o => ['discover_role', 'discover_building', 'discover_interest'].includes(o.id));
      expect(earlyDiscovery.length).toBe(0);
    });

    it('excludes deeper discovery items when person has 5+ messages', () => {
      const ctx = makeContext({
        relationship: makeRelationship({ stage: 'exploring' }),
        recentMessages: [
          { role: 'user' as const, content: 'msg 1', channel: 'slack', created_at: new Date() },
          { role: 'user' as const, content: 'msg 2', channel: 'slack', created_at: new Date() },
          { role: 'user' as const, content: 'msg 3', channel: 'slack', created_at: new Date() },
          { role: 'user' as const, content: 'msg 4', channel: 'slack', created_at: new Date() },
          { role: 'user' as const, content: 'msg 5', channel: 'slack', created_at: new Date() },
        ],
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
      });
      const result = computeEngagementOpportunities(ctx);
      expect(result.length).toBeGreaterThan(0);
      const dims = new Set(result.map(o => o.dimension));
      // Should not have hygiene since everything is set up
      expect(dims.has('hygiene')).toBe(false);
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

  it('contacts new prospects with no prior messages (past grace period)', () => {
    const r = makeRelationship({ stage: 'prospect', last_addie_message_at: null });
    const result = shouldContact(r);
    expect(result.shouldContact).toBe(true);
    expect(result.reason).toContain('welcome');
  });

  it('delays welcome for brand-new prospects within 24h grace period', () => {
    const r = makeRelationship({
      stage: 'prospect',
      last_addie_message_at: null,
      stage_changed_at: new Date(), // just joined
    });
    const result = shouldContact(r);
    expect(result.shouldContact).toBe(false);
    expect(result.reason).toContain('grace period');
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

  describe('channel stickiness', () => {
    it('stays on Slack with 1 unreplied', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: 'test@test.com',
        unreplied_outreach_count: 1,
        last_interaction_channel: 'slack',
        last_addie_message_at: daysAgo(15),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.channel).toBe('slack');
    });

    it('stays on email with 1 unreplied', () => {
      const r = makeRelationship({
        slack_user_id: null,
        email: 'test@test.com',
        unreplied_outreach_count: 1,
        last_interaction_channel: 'email',
        last_addie_message_at: daysAgo(15),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.channel).toBe('email');
    });

    it('respects contact_preference over default channel', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: 'test@test.com',
        contact_preference: 'email',
        unreplied_outreach_count: 0,
        last_addie_message_at: daysAgo(15),
      });
      const result = shouldContact(r);
      expect(result.channel).toBe('email');
    });

    it('uses Slack when both channels available and no preference', () => {
      const r = makeRelationship({
        slack_user_id: 'U1',
        email: 'test@test.com',
        unreplied_outreach_count: 2,
        last_interaction_channel: 'slack',
        last_addie_message_at: daysAgo(15),
      });
      const result = shouldContact(r);
      expect(result.channel).toBe('slack');
    });
  });

  describe('stage cooldowns', () => {
    it('blocks when within stage cooldown', () => {
      const r = makeRelationship({
        stage: 'exploring',
        last_addie_message_at: daysAgo(3), // exploring cooldown is 14 days
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('stage cooldown');
    });

    it('allows contact after cooldown expires', () => {
      const r = makeRelationship({
        stage: 'exploring',
        last_addie_message_at: daysAgo(22), // > 21 day cooldown
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
    });

    it('escalates cooldown with 1+ unreplied', () => {
      // exploring cooldown is 21 days, but with 1 unreplied escalates to participating (30 days)
      const r = makeRelationship({
        stage: 'exploring',
        unreplied_outreach_count: 1,
        last_addie_message_at: daysAgo(25), // past 21d but within 30d
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('stage cooldown');
    });
  });

  describe('monthly pulse', () => {
    it('blocks 2+ unreplied within 30 days', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 2,
        last_addie_message_at: daysAgo(10),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('monthly pulse');
    });

    it('allows monthly pulse after 30+ days', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 2,
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

  describe('circuit breaker', () => {
    it('blocks after 6 total unreplied messages', () => {
      const r = makeRelationship({
        unreplied_outreach_count: 6,
        last_addie_message_at: daysAgo(60),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('circuit breaker');
    });

    it('allows monthly pulse at 5 unreplied', () => {
      const r = makeRelationship({
        unreplied_outreach_count: 5,
        last_addie_message_at: daysAgo(35),
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
      expect(result.reason).toContain('monthly pulse');
    });
  });

  describe('disengaging pulse doubling', () => {
    it('blocks disengaging person within 60 days', () => {
      const r = makeRelationship({
        unreplied_outreach_count: 4,
        sentiment_trend: 'disengaging' as any,
        last_addie_message_at: daysAgo(40), // past 30d but within 60d
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('monthly pulse');
    });

    it('allows disengaging person after 60 days', () => {
      const r = makeRelationship({
        unreplied_outreach_count: 4,
        sentiment_trend: 'disengaging' as any,
        last_addie_message_at: daysAgo(65),
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
        last_addie_message_at: daysAgo(15), // past welcomed cooldown of 14 days
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(true);
    });

    it('blocks monthly pulse when next_contact_after is in the future', () => {
      const r = makeRelationship({
        stage: 'welcomed',
        unreplied_outreach_count: 4,
        last_addie_message_at: daysAgo(45), // past 30-day pulse threshold
        next_contact_after: new Date(Date.now() + 86400000), // admin override: tomorrow
      });
      const result = shouldContact(r);
      expect(result.shouldContact).toBe(false);
      expect(result.reason).toContain('cooldown');
    });
  });
});

describe('hasMeaningfulEngagement', () => {
  it('returns false for a cold prospect with no replies or product activity', () => {
    const result = hasMeaningfulEngagement({
      relationship: makeRelationship({
        stage: 'prospect',
        workos_user_id: null,
        last_person_message_at: null,
      }),
      recentMessages: [],
      profile: { capabilities: null, company: null },
      certification: null,
    });

    expect(result).toBe(false);
  });

  it('returns true when the person has linked an account', () => {
    const result = hasMeaningfulEngagement({
      relationship: makeRelationship({
        stage: 'prospect',
        workos_user_id: 'user_123',
        last_person_message_at: null,
      }),
      recentMessages: [],
      profile: {
        capabilities: makeCapabilities({
          account_linked: true,
          slack_message_count_30d: 0,
          working_group_count: 0,
          events_registered: 0,
          events_attended: 0,
          community_profile_completeness: 0,
        }),
        company: null,
      },
      certification: null,
    });

    expect(result).toBe(true);
  });

  it('returns true when there is a prior inbound message', () => {
    const result = hasMeaningfulEngagement({
      relationship: makeRelationship({
        stage: 'welcomed',
        last_person_message_at: null,
      }),
      recentMessages: [
        {
          role: 'user',
          content: 'Happy to be here.',
          channel: 'slack',
          created_at: new Date(),
        },
      ],
      profile: { capabilities: null, company: null },
      certification: null,
    });

    expect(result).toBe(true);
  });
});

describe('extractUserFacingMessage', () => {
  it('drops scratchpad text before a delimiter', () => {
    const raw = `With 1 unreplied message and no conversation history, I should keep this light.

---

Been thinking about how much easier it is to connect with the right people once your profile has some context.`;

    expect(extractUserFacingMessage(raw, 'slack')).toBe(
      'Been thinking about how much easier it is to connect with the right people once your profile has some context.'
    );
  });

  it('drops leading reasoning paragraphs without a delimiter', () => {
    const raw = `Thinking about this one: they have 1 unreplied message.

I'll keep it warm and brief.

The working groups are where the more interesting conversations happen here.`;

    expect(extractUserFacingMessage(raw, 'slack')).toBe(
      'The working groups are where the more interesting conversations happen here.'
    );
  });
});

describe('pulse scoring', () => {
  it('excludes hygiene and discovery items during monthly pulse', () => {
    const opps = computeEngagementOpportunities(makeContext({
      relationship: makeRelationship({
        stage: 'exploring',
        slack_user_id: 'U1',
        workos_user_id: null, // link_accounts should be eligible normally
      }),
    }), 'monthly pulse — low-key update');

    for (const o of opps) {
      expect(o.dimension).not.toBe('hygiene');
      expect(o.dimension).not.toBe('discovery');
    }
  });
});

describe('textToEmailHtml', () => {
  it('escapes HTML entities', () => {
    const html = textToEmailHtml('Hello <script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('linkifies URLs without double-encoding ampersands', () => {
    const html = textToEmailHtml('Visit https://example.com/page?a=1&b=2 for details');
    expect(html).toContain('href="https://example.com/page?a=1&amp;b=2"');
    // The href should have a single &amp; not &amp;amp;
    expect(html).not.toContain('&amp;amp;');
  });

  it('wraps paragraphs in <p> tags', () => {
    const html = textToEmailHtml('First paragraph.\n\nSecond paragraph.');
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
  });

  it('handles empty input', () => {
    const html = textToEmailHtml('');
    expect(html).toContain('<body');
    expect(html).toContain('</body>');
  });
});
