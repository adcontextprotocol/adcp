/**
 * Org health computation
 *
 * Aggregates individual engagement data into an org-level health score.
 * Health score is 0-100, derived from weighted signals:
 * certification %, working group %, active %, content, leadership, tech integration.
 */

import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('org-health');

// Health score weights (must sum to 1.0)
const WEIGHTS = {
  certification_pct: 0.25,
  working_group_pct: 0.25,
  active_pct: 0.15,
  content_contributions: 0.10,
  leadership_roles: 0.10,
  tech_integration: 0.10,
  seat_utilization: 0.05,
} as const;

export interface OrgHealthBreakdown {
  certification_pct: number;
  working_group_pct: number;
  active_pct: number;
  content_contributions: number;
  leadership_roles: number;
  tech_integration: {
    agents_registered: number;
  };
  seat_utilization_pct: number;
}

export interface OrgHealthPerson {
  name: string;
  email: string;
  workos_user_id: string;
  seat_type: string;
  credentials: string[];
  working_groups: string[];
  last_active: string | null;
  contribution_count: number;
  community_points: number;
}

export interface OrgHealthChampion {
  name: string;
  highlights: string[];
}

export interface SuggestedAction {
  action: string;
  label: string;
  impact: string;
  url: string;
}

export interface HealthTrajectory {
  current: number;
  previous: number | null;
  previous_date: string | null;
}

export interface OrgHealth {
  organization: {
    name: string;
    membership_tier: string | null;
    persona: string | null;
    member_since: string;
  };
  health_score: number;
  health_trajectory: HealthTrajectory;
  health_breakdown: OrgHealthBreakdown;
  people: OrgHealthPerson[];
  champions: OrgHealthChampion[];
  suggested_actions: SuggestedAction[];
}

export function computeHealthScore(breakdown: OrgHealthBreakdown): number {
  // Each signal is normalized to 0-100, then weighted
  const certScore = Math.min(100, breakdown.certification_pct);
  const groupScore = Math.min(100, breakdown.working_group_pct);
  const activeScore = Math.min(100, breakdown.active_pct);

  // Content: cap at 10 contributions = 100%
  const contentScore = Math.min(100, breakdown.content_contributions * 10);

  // Leadership: cap at 3 roles = 100%
  const leadershipScore = Math.min(100, breakdown.leadership_roles * 33.3);

  // Tech: cap at 3 agents = 100%
  const techScore = Math.min(100, breakdown.tech_integration.agents_registered * 33.3);

  const seatScore = Math.min(100, breakdown.seat_utilization_pct);

  const raw =
    certScore * WEIGHTS.certification_pct +
    groupScore * WEIGHTS.working_group_pct +
    activeScore * WEIGHTS.active_pct +
    contentScore * WEIGHTS.content_contributions +
    leadershipScore * WEIGHTS.leadership_roles +
    techScore * WEIGHTS.tech_integration +
    seatScore * WEIGHTS.seat_utilization;

  return Math.round(raw);
}

export function identifyChampions(people: OrgHealthPerson[]): OrgHealthChampion[] {
  return people
    .filter(p => p.credentials.length > 0 || p.working_groups.length > 0 || p.contribution_count > 0)
    .sort((a, b) => {
      const scoreA = a.credentials.length * 3 + a.working_groups.length * 2 + a.contribution_count;
      const scoreB = b.credentials.length * 3 + b.working_groups.length * 2 + b.contribution_count;
      return scoreB - scoreA;
    })
    .slice(0, 3)
    .map(p => {
      const highlights: string[] = [];
      if (p.credentials.length > 0) highlights.push(`${p.credentials.join(', ')} certified`);
      if (p.working_groups.length > 0) highlights.push(`In ${p.working_groups.join(', ')}`);
      if (p.contribution_count > 0) highlights.push(`${p.contribution_count} contribution${p.contribution_count > 1 ? 's' : ''}`);
      return { name: p.name, highlights };
    })
    .filter(c => c.highlights.length > 0);
}

export function suggestActions(
  breakdown: OrgHealthBreakdown,
  persona: string | null,
  contributorCount: number,
): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  if (breakdown.certification_pct < 50 && contributorCount > 0) {
    const needed = Math.ceil(contributorCount * 0.5) - Math.round(contributorCount * breakdown.certification_pct / 100);
    const label = persona === 'molecule_builder' || persona === 'resops_integrator'
      ? `Certify ${needed} more people on your media buying team`
      : `Get ${needed} more people certified`;
    actions.push({
      action: 'increase_certification',
      label,
      impact: `Would bring your certification rate to 50%`,
      url: '/certification',
    });
  }

  if (breakdown.working_group_pct < 30) {
    actions.push({
      action: 'join_working_groups',
      label: 'Get your team into working groups',
      impact: 'Working groups are where protocol work gets done',
      url: '/committees?type=working_group',
    });
  }

  if (breakdown.active_pct < 50) {
    actions.push({
      action: 'reactivate_members',
      label: 'Invite inactive team members back',
      impact: 'Active members get more from the community',
      url: '/dashboard/team',
    });
  }

  if (breakdown.seat_utilization_pct < 60 && contributorCount > 2) {
    const inactiveCount = Math.round((1 - breakdown.seat_utilization_pct / 100) * contributorCount);
    if (inactiveCount > 0) {
      actions.push({
        action: 'reassign_seats',
        label: `${inactiveCount} seat${inactiveCount > 1 ? 's' : ''} haven't been used in 30 days — consider reassigning`,
        impact: 'Free up seats for team members who will use them',
        url: '/dashboard/team',
      });
    }
  }

  if (breakdown.tech_integration.agents_registered === 0) {
    const label = persona === 'molecule_builder' || persona === 'resops_integrator'
      ? 'Register a buyer agent to start testing'
      : persona === 'pureblood_protector'
        ? 'Register a seller agent to connect your inventory'
        : 'Register an agent to start integrating';
    actions.push({
      action: 'register_agent',
      label,
      impact: 'Connect your tech to the protocol',
      url: '/chat?prompt=' + encodeURIComponent('I want to add an agent for compliance monitoring.'),
    });
  }

  if (breakdown.content_contributions === 0 && breakdown.certification_pct > 0) {
    actions.push({
      action: 'contribute_content',
      label: 'Share your team\'s expertise with a perspective',
      impact: 'Published content builds your org\'s visibility',
      url: '/my-content',
    });
  }

  return actions.slice(0, 3);
}

/**
 * Resolve the user's org and check access.
 * Returns orgId if the user has access (admin/owner or contributor seat), null otherwise.
 */
export async function resolveOrgAccess(userId: string): Promise<{
  orgId: string;
  role: string;
  seatType: string;
} | null> {
  const result = await query<{
    workos_organization_id: string;
    role: string;
    seat_type: string;
    is_personal: boolean;
  }>(
    `SELECT om.workos_organization_id, om.role, om.seat_type, o.is_personal
     FROM organization_memberships om
     JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
     WHERE om.workos_user_id = $1 AND o.is_personal = false
     ORDER BY om.workos_organization_id
     LIMIT 1`,
    [userId]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    orgId: row.workos_organization_id,
    role: row.role,
    seatType: row.seat_type,
  };
}

export async function assembleOrgHealth(orgId: string): Promise<OrgHealth> {
  const [
    orgData,
    people,
    agentCount,
    leadershipResult,
  ] = await Promise.all([
    // Org metadata
    query<{
      name: string;
      membership_tier: string | null;
      persona: string | null;
      created_at: string;
    }>(
      `SELECT name, membership_tier, persona, created_at
       FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    ).then(r => r.rows[0] ?? null).catch(err => {
      logger.error({ err, orgId }, 'Failed to fetch org data');
      return null;
    }),

    // People with engagement data
    query<{
      workos_user_id: string;
      first_name: string | null;
      last_name: string | null;
      email: string;
      seat_type: string;
      credentials: string | null; // comma-separated
      working_groups: string | null; // comma-separated
      last_active: string | null;
      contribution_count: string;
      community_points: string;
      ever_logged_in: boolean;
    }>(
      `SELECT
         om.workos_user_id,
         u.first_name, u.last_name, u.email,
         om.seat_type,
         (SELECT string_agg(DISTINCT cc.name, ', ')
          FROM user_credentials uc
          JOIN certification_credentials cc ON cc.id = uc.credential_id
          WHERE uc.workos_user_id = om.workos_user_id) as credentials,
         (SELECT string_agg(DISTINCT wg.name, ', ')
          FROM working_group_memberships wgm
          JOIN working_groups wg ON wg.id = wgm.working_group_id
          WHERE wgm.workos_user_id = om.workos_user_id AND wgm.status = 'active') as working_groups,
         (SELECT MAX(cp.created_at)
          FROM community_points cp
          WHERE cp.workos_user_id = om.workos_user_id) as last_active,
         (SELECT COUNT(DISTINCT p.id)
          FROM perspectives p
          WHERE (p.author_user_id = om.workos_user_id
                 OR p.proposer_user_id = om.workos_user_id)
            AND p.status = 'published') as contribution_count,
         (SELECT COALESCE(SUM(cp.points), 0)
          FROM community_points cp
          WHERE cp.workos_user_id = om.workos_user_id) as community_points,
         EXISTS(SELECT 1 FROM community_points cp
                WHERE cp.workos_user_id = om.workos_user_id) as ever_logged_in
       FROM organization_memberships om
       JOIN users u ON u.workos_user_id = om.workos_user_id
       WHERE om.workos_organization_id = $1
       ORDER BY community_points DESC, u.first_name`,
      [orgId]
    ).then(r => r.rows).catch(err => {
      logger.error({ err, orgId }, 'Failed to fetch people data');
      return [];
    }),

    // Agent count — no org-scoped agents table yet; always 0 until one exists
    Promise.resolve(0),

    // Leadership roles across all org members
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT wgl.working_group_id) as count
       FROM working_group_leaders wgl
       LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = wgl.user_id
       JOIN organization_memberships om ON om.workos_user_id = COALESCE(sm.workos_user_id, wgl.user_id)
       WHERE om.workos_organization_id = $1`,
      [orgId]
    ).then(r => r).catch(err => {
      logger.error({ err, orgId }, 'Failed to fetch leadership count');
      return { rows: [{ count: '0' }] };
    }),
  ]);

  const leadershipRoles = parseInt(leadershipResult.rows[0]?.count || '0', 10);

  // Compute breakdown from people data
  const contributorSeats = people.filter(p => p.seat_type === 'contributor');
  const contributorCount = contributorSeats.length;
  const totalSeats = people.length;

  const certifiedCount = people.filter(p => p.credentials).length;
  const inGroupCount = people.filter(p => p.working_groups).length;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const activeCount = people.filter(p =>
    p.last_active && new Date(p.last_active) > thirtyDaysAgo
  ).length;

  // Seat utilization: seats that have ever been used (distinct from 30-day active)
  const usedSeatCount = people.filter(p => p.ever_logged_in).length;

  let totalContributions = 0;
  for (const p of people) {
    totalContributions += parseInt(p.contribution_count || '0', 10);
  }

  const denominator = contributorCount || totalSeats || 1;
  const breakdown: OrgHealthBreakdown = {
    certification_pct: Math.round((certifiedCount / denominator) * 100),
    working_group_pct: Math.round((inGroupCount / denominator) * 100),
    active_pct: totalSeats > 0 ? Math.round((activeCount / totalSeats) * 100) : 0,
    content_contributions: totalContributions,
    leadership_roles: leadershipRoles,
    tech_integration: { agents_registered: agentCount },
    seat_utilization_pct: totalSeats > 0 ? Math.round((usedSeatCount / totalSeats) * 100) : 0,
  };

  const healthScore = computeHealthScore(breakdown);

  const mappedPeople: OrgHealthPerson[] = people.map(p => ({
    name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
    email: p.email,
    workos_user_id: p.workos_user_id,
    seat_type: p.seat_type,
    credentials: p.credentials ? p.credentials.split(', ') : [],
    working_groups: p.working_groups ? p.working_groups.split(', ') : [],
    last_active: p.last_active,
    contribution_count: parseInt(p.contribution_count || '0', 10),
    community_points: parseInt(p.community_points || '0', 10),
  }));

  const champions = identifyChampions(mappedPeople);
  const actions = suggestActions(breakdown, orgData?.persona ?? null, contributorCount);

  return {
    organization: {
      name: orgData?.name ?? '',
      membership_tier: orgData?.membership_tier ?? null,
      persona: orgData?.persona ?? null,
      member_since: orgData?.created_at ?? new Date().toISOString(),
    },
    health_score: healthScore,
    health_trajectory: await getHealthTrajectory(orgId, healthScore),
    health_breakdown: breakdown,
    people: mappedPeople,
    champions,
    suggested_actions: actions,
  };
}

async function getHealthTrajectory(orgId: string, currentScore: number): Promise<HealthTrajectory> {
  try {
    // Get the snapshot from 14+ days ago for stable comparison (not yesterday's noise)
    const prevResult = await query<{ value: string; set_at: string }>(
      `SELECT value, set_at FROM org_knowledge
       WHERE workos_organization_id = $1
         AND attribute = 'health_score'
         AND set_at < NOW() - INTERVAL '14 days'
       ORDER BY set_at DESC
       LIMIT 1`,
      [orgId]
    );

    const prev = prevResult.rows[0];
    const prevScore = prev ? parseInt(prev.value, 10) : null;
    const prevDate = prev?.set_at ?? null;

    // Store current snapshot (at most once per day — check before inserting)
    const today = new Date().toISOString().slice(0, 10);
    const existsToday = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM org_knowledge
       WHERE workos_organization_id = $1
         AND attribute = 'health_score'
         AND source = 'enrichment'
         AND source_reference = $2`,
      [orgId, today]
    ).then(r => parseInt(r.rows[0]?.count ?? '0', 10) > 0).catch(() => false);

    if (!existsToday) {
      await query(
        `INSERT INTO org_knowledge (
          workos_organization_id, attribute, value, value_json,
          source, confidence, source_reference
        ) VALUES ($1, 'health_score', $2, $3, 'enrichment', 'high', $4)`,
        [orgId, String(currentScore), JSON.stringify({ score: currentScore, date: today }), today]
      ).catch(() => {
        // Non-critical — snapshot storage is best-effort
      });
    }

    return {
      current: currentScore,
      previous: prevScore,
      previous_date: prevDate,
    };
  } catch {
    return { current: currentScore, previous: null, previous_date: null };
  }
}
