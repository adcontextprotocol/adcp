/**
 * Persona-Aware Working Group Recommendations
 *
 * Suggests working groups to members based on their org's persona
 * and the persona-council affinity matrix.
 */

import { getPool } from '../../db/client.js';
import type { Persona } from '../../db/org-knowledge-db.js';
import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'group-recommendations' });

export interface GroupRecommendation {
  working_group_id: string;
  name: string;
  slug: string;
  description: string | null;
  committee_type: string;
  affinity_score: number;
  reason: string;
}

const personaLabels: Record<string, string> = {
  molecule_builder: 'Molecule Builder',
  data_decoder: 'Data Decoder',
  pureblood_protector: 'Pureblood Protector',
  resops_integrator: 'ResOps Integrator',
  ladder_climber: 'Ladder Climber',
  simple_starter: 'Simple Starter',
};

function buildReason(affinityScore: number, persona: string): string {
  const label = personaLabels[persona] || persona;
  if (affinityScore >= 5) return `Highly recommended for ${label} organizations`;
  if (affinityScore >= 4) return `Strong match for ${label} organizations`;
  return `Good fit for ${label} organizations`;
}

/**
 * Get recommended working groups for a user based on their org's persona.
 * Excludes groups the user is already a member of.
 */
export async function getRecommendedGroups(
  workosUserId: string,
  options: { limit?: number } = {}
): Promise<GroupRecommendation[]> {
  const { limit = 5 } = options;
  const pool = getPool();

  // Get user's org
  const orgResult = await pool.query<{ workos_organization_id: string; persona: Persona | null }>(
    `SELECT om.workos_organization_id, o.persona
     FROM organization_memberships om
     JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
     WHERE om.workos_user_id = $1
     LIMIT 1`,
    [workosUserId]
  );

  if (!orgResult.rows[0]) {
    logger.debug({ workosUserId }, 'No org found for user, cannot recommend groups');
    return [];
  }

  const { workos_organization_id: orgId, persona } = orgResult.rows[0];

  if (!persona) {
    logger.debug({ workosUserId, orgId }, 'No persona for org, cannot recommend groups');
    return [];
  }

  // Get high-affinity groups for this persona, excluding groups user is already in
  const result = await pool.query<{
    working_group_id: string;
    name: string;
    slug: string;
    description: string | null;
    committee_type: string;
    affinity_score: number;
  }>(
    `SELECT pga.working_group_id, wg.name, wg.slug, wg.description, wg.committee_type, pga.affinity_score
     FROM persona_group_affinity pga
     JOIN working_groups wg ON wg.id = pga.working_group_id
     WHERE pga.persona = $1
       AND wg.status = 'active'
       AND pga.affinity_score >= 3
       AND NOT EXISTS (
         SELECT 1 FROM working_group_memberships wgm
         WHERE wgm.working_group_id = pga.working_group_id
           AND wgm.workos_user_id = $2
           AND wgm.status = 'active'
       )
     ORDER BY pga.affinity_score DESC, wg.name
     LIMIT $3`,
    [persona, workosUserId, limit]
  );

  return result.rows.map(row => ({
    working_group_id: row.working_group_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    committee_type: row.committee_type,
    affinity_score: row.affinity_score,
    reason: buildReason(row.affinity_score, persona),
  }));
}

/**
 * Get recommended groups for an org by org ID (for use in outreach).
 */
export async function getRecommendedGroupsForOrg(
  orgId: string,
  options: { limit?: number; excludeUserIds?: string[] } = {}
): Promise<GroupRecommendation[]> {
  const { limit = 5, excludeUserIds = [] } = options;
  const pool = getPool();

  // Get org's persona
  const orgResult = await pool.query<{ persona: Persona | null }>(
    `SELECT persona FROM organizations WHERE workos_organization_id = $1`,
    [orgId]
  );

  const persona = orgResult.rows[0]?.persona;
  if (!persona) return [];

  // Get high-affinity groups, optionally excluding groups any of the given users belong to
  let excludeClause = '';
  const params: (string | number | string[])[] = [persona, limit];

  if (excludeUserIds.length > 0) {
    excludeClause = `AND NOT EXISTS (
      SELECT 1 FROM working_group_memberships wgm
      WHERE wgm.working_group_id = pga.working_group_id
        AND wgm.workos_user_id = ANY($3)
        AND wgm.status = 'active'
    )`;
    params.push(excludeUserIds);
  }

  const result = await pool.query<{
    working_group_id: string;
    name: string;
    slug: string;
    description: string | null;
    committee_type: string;
    affinity_score: number;
  }>(
    `SELECT pga.working_group_id, wg.name, wg.slug, wg.description, wg.committee_type, pga.affinity_score
     FROM persona_group_affinity pga
     JOIN working_groups wg ON wg.id = pga.working_group_id
     WHERE pga.persona = $1
       AND wg.status = 'active'
       AND pga.affinity_score >= 3
       ${excludeClause}
     ORDER BY pga.affinity_score DESC, wg.name
     LIMIT $2`,
    params
  );

  return result.rows.map(row => ({
    working_group_id: row.working_group_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    committee_type: row.committee_type,
    affinity_score: row.affinity_score,
    reason: buildReason(row.affinity_score, persona),
  }));
}
