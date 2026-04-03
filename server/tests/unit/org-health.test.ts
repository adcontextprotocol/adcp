import { describe, it, expect } from 'vitest';
import {
  computeHealthScore,
  identifyChampions,
  suggestActions,
  type OrgHealthBreakdown,
  type OrgHealthPerson,
} from '../../src/services/org-health.js';

describe('computeHealthScore', () => {
  it('returns 0 for a completely disengaged org', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 0,
      working_group_pct: 0,
      active_pct: 0,
      content_contributions: 0,
      leadership_roles: 0,
      tech_integration: { agents_registered: 0 },
      seat_utilization_pct: 0,
    };
    expect(computeHealthScore(breakdown)).toBe(0);
  });

  it('returns 100 for a fully engaged org', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 100,
      working_group_pct: 100,
      active_pct: 100,
      content_contributions: 10,
      leadership_roles: 3,
      tech_integration: { agents_registered: 3 },
      seat_utilization_pct: 100,
    };
    // Should be close to 100 (rounding may cause slight variation)
    const score = computeHealthScore(breakdown);
    expect(score).toBeGreaterThanOrEqual(98);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('weights certification and working groups highest', () => {
    const certOnly: OrgHealthBreakdown = {
      certification_pct: 100,
      working_group_pct: 0,
      active_pct: 0,
      content_contributions: 0,
      leadership_roles: 0,
      tech_integration: { agents_registered: 0 },
      seat_utilization_pct: 0,
    };
    const activeOnly: OrgHealthBreakdown = {
      certification_pct: 0,
      working_group_pct: 0,
      active_pct: 100,
      content_contributions: 0,
      leadership_roles: 0,
      tech_integration: { agents_registered: 0 },
      seat_utilization_pct: 0,
    };

    expect(computeHealthScore(certOnly)).toBeGreaterThan(computeHealthScore(activeOnly));
  });

  it('returns a mid-range score for partial engagement', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 50,
      working_group_pct: 33,
      active_pct: 67,
      content_contributions: 2,
      leadership_roles: 1,
      tech_integration: { agents_registered: 1 },
      seat_utilization_pct: 67,
    };
    const score = computeHealthScore(breakdown);
    expect(score).toBeGreaterThan(25);
    expect(score).toBeLessThan(75);
  });
});

describe('identifyChampions', () => {
  const people: OrgHealthPerson[] = [
    {
      name: 'Pia', email: 'pia@acme.com', workos_user_id: '1', seat_type: 'contributor',
      credentials: ['Practitioner'], working_groups: ['Media Buying', 'Creative'],
      last_active: '2026-03-30', contribution_count: 3, community_points: 350,
    },
    {
      name: 'Marco', email: 'marco@acme.com', workos_user_id: '2', seat_type: 'contributor',
      credentials: ['Basics'], working_groups: [],
      last_active: '2026-03-15', contribution_count: 0, community_points: 50,
    },
    {
      name: 'Jan', email: 'jan@acme.com', workos_user_id: '3', seat_type: 'contributor',
      credentials: [], working_groups: [],
      last_active: null, contribution_count: 0, community_points: 0,
    },
  ];

  it('identifies the most engaged person as champion', () => {
    const champions = identifyChampions(people);
    expect(champions[0].name).toBe('Pia');
    expect(champions[0].highlights).toContain('Practitioner certified');
  });

  it('excludes people with no engagement', () => {
    const champions = identifyChampions(people);
    const names = champions.map(c => c.name);
    expect(names).not.toContain('Jan');
  });

  it('returns at most 3 champions', () => {
    const manyPeople = Array.from({ length: 10 }, (_, i) => ({
      name: `Person ${i}`, email: `p${i}@acme.com`, workos_user_id: String(i),
      seat_type: 'contributor', credentials: ['Basics'],
      working_groups: ['Group A'], last_active: '2026-03-30',
      contribution_count: 1, community_points: 100,
    }));
    expect(identifyChampions(manyPeople).length).toBeLessThanOrEqual(3);
  });
});

describe('suggestActions', () => {
  it('suggests certification when under 50%', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 20,
      working_group_pct: 50,
      active_pct: 80,
      content_contributions: 2,
      leadership_roles: 1,
      tech_integration: { agents_registered: 1 },
      seat_utilization_pct: 80,
    };
    const actions = suggestActions(breakdown, null, 5);
    expect(actions.some(a => a.action === 'increase_certification')).toBe(true);
  });

  it('suggests agent registration when none registered', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 80,
      working_group_pct: 60,
      active_pct: 90,
      content_contributions: 3,
      leadership_roles: 1,
      tech_integration: { agents_registered: 0 },
      seat_utilization_pct: 90,
    };
    const actions = suggestActions(breakdown, null, 5);
    expect(actions.some(a => a.action === 'register_agent')).toBe(true);
  });

  it('uses persona-specific language for agencies', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 20,
      working_group_pct: 0,
      active_pct: 50,
      content_contributions: 0,
      leadership_roles: 0,
      tech_integration: { agents_registered: 0 },
      seat_utilization_pct: 50,
    };
    const actions = suggestActions(breakdown, 'molecule_builder', 5);
    const certAction = actions.find(a => a.action === 'increase_certification');
    expect(certAction?.label).toContain('media buying');
  });

  it('returns at most 3 suggestions', () => {
    const breakdown: OrgHealthBreakdown = {
      certification_pct: 0,
      working_group_pct: 0,
      active_pct: 0,
      content_contributions: 0,
      leadership_roles: 0,
      tech_integration: { agents_registered: 0 },
      seat_utilization_pct: 0,
    };
    const actions = suggestActions(breakdown, null, 5);
    expect(actions.length).toBeLessThanOrEqual(3);
  });
});
