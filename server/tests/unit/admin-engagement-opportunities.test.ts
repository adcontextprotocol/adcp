import { describe, it, expect } from 'vitest';
import { OPPORTUNITY_CATALOG } from '../../src/addie/services/engagement-planner.js';
import type { PersonRelationship } from '../../src/db/relationship-db.js';

function makeRelationship(overrides: Partial<PersonRelationship> = {}): PersonRelationship {
  return {
    id: 'test-person',
    display_name: 'Test Person',
    email: 'test@example.com',
    slack_user_id: 'U123',
    workos_user_id: 'workos_123',
    prospect_org_id: null,
    stage: 'participating',
    stage_changed_at: new Date(),
    sentiment_trend: 'neutral',
    interaction_count: 5,
    last_person_message_at: new Date(),
    last_addie_message_at: null,
    unreplied_outreach_count: 0,
    next_contact_after: null,
    contact_preference: null,
    ...overrides,
  } as PersonRelationship;
}

function getCatalogEntry(id: string) {
  const entry = OPPORTUNITY_CATALOG.find(e => e.id === id);
  if (!entry) throw new Error(`Catalog entry ${id} not found`);
  return entry;
}

describe('admin engagement opportunity conditions', () => {
  it('catalog includes all new opportunities', () => {
    const ids = ['org_health_review', 'team_certification_push', 'next_certification_tier', 'second_working_group', 'first_contribution'];
    for (const id of ids) {
      expect(OPPORTUNITY_CATALOG.some(e => e.id === id), `Missing: ${id}`).toBe(true);
    }
  });

  describe('org_health_review', () => {
    const entry = getCatalogEntry('org_health_review');

    it('fires for org admin', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: { is_org_admin: true } as any,
        company: null, recentMessages: [], certification: null,
      };
      expect(entry.condition(ctx)).toBe(true);
    });

    it('does not fire for non-admin', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: { is_org_admin: false } as any,
        company: null, recentMessages: [], certification: null,
      };
      expect(entry.condition(ctx)).toBe(false);
    });
  });

  describe('team_certification_push', () => {
    const entry = getCatalogEntry('team_certification_push');

    it('fires when admin and cert rate < 50%', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: { is_org_admin: true } as any,
        company: null, recentMessages: [],
        certification: {
          modulesCompleted: 0, totalModules: 10,
          credentialsEarned: [], hasInProgressTrack: false, abandonedModuleTitle: null,
          teamCertProgress: { certified: 1, total: 8 },
        },
      };
      expect(entry.condition(ctx)).toBe(true);
    });

    it('does not fire when cert rate >= 50%', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: { is_org_admin: true } as any,
        company: null, recentMessages: [],
        certification: {
          modulesCompleted: 5, totalModules: 10,
          credentialsEarned: ['basics'], hasInProgressTrack: false, abandonedModuleTitle: null,
          teamCertProgress: { certified: 6, total: 8 },
        },
      };
      expect(entry.condition(ctx)).toBe(false);
    });

    it('does not fire for non-admin', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: { is_org_admin: false } as any,
        company: null, recentMessages: [],
        certification: {
          modulesCompleted: 0, totalModules: 10,
          credentialsEarned: [], hasInProgressTrack: false, abandonedModuleTitle: null,
          teamCertProgress: { certified: 1, total: 8 },
        },
      };
      expect(entry.condition(ctx)).toBe(false);
    });
  });

  describe('second_working_group', () => {
    const entry = getCatalogEntry('second_working_group');

    it('fires when user is in exactly 1 group', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [], certification: null,
        journey: { tier: 'connector', points: 150, working_groups: ['Media Buying'], credentials: ['Basics'], contribution_count: 0, notable_colleagues: [] },
      };
      expect(entry.condition(ctx)).toBe(true);
    });

    it('does not fire when user is in 0 or 2+ groups', () => {
      const ctx0 = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [], certification: null,
        journey: { tier: 'explorer', points: 0, working_groups: [], credentials: [], contribution_count: 0, notable_colleagues: [] },
      };
      expect(entry.condition(ctx0)).toBe(false);

      const ctx2 = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [], certification: null,
        journey: { tier: 'champion', points: 250, working_groups: ['Media Buying', 'Creative'], credentials: [], contribution_count: 0, notable_colleagues: [] },
      };
      expect(entry.condition(ctx2)).toBe(false);
    });
  });

  describe('first_contribution', () => {
    const entry = getCatalogEntry('first_contribution');

    it('fires for credentialed user with no contributions', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [], certification: null,
        journey: { tier: 'connector', points: 150, working_groups: ['Media Buying'], credentials: ['Basics'], contribution_count: 0, notable_colleagues: [] },
      };
      expect(entry.condition(ctx)).toBe(true);
    });

    it('does not fire when user already has contributions', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [], certification: null,
        journey: { tier: 'champion', points: 250, working_groups: [], credentials: ['Basics'], contribution_count: 2, notable_colleagues: [] },
      };
      expect(entry.condition(ctx)).toBe(false);
    });

    it('does not fire for user with no credentials', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [], certification: null,
        journey: { tier: 'explorer', points: 50, working_groups: [], credentials: [], contribution_count: 0, notable_colleagues: [] },
      };
      expect(entry.condition(ctx)).toBe(false);
    });
  });

  describe('next_certification_tier', () => {
    const entry = getCatalogEntry('next_certification_tier');

    it('fires when user has credentials and no in-progress track', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [],
        certification: {
          modulesCompleted: 5, totalModules: 10,
          credentialsEarned: ['basics'], hasInProgressTrack: false, abandonedModuleTitle: null,
        },
      };
      expect(entry.condition(ctx)).toBe(true);
    });

    it('does not fire when track is in progress', () => {
      const ctx = {
        relationship: makeRelationship(),
        capabilities: null, company: null, recentMessages: [],
        certification: {
          modulesCompleted: 3, totalModules: 10,
          credentialsEarned: ['basics'], hasInProgressTrack: true, abandonedModuleTitle: null,
        },
      };
      expect(entry.condition(ctx)).toBe(false);
    });
  });
});
