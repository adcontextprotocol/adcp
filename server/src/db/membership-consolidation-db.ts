/**
 * Consolidation checks for the credential-binding admin paths (#6827).
 *
 * `mergeUsers` moves a membership onto the target credential by rewriting
 * `workos_user_id`. Where the target already holds a row for the same
 * organization or working group, the unique constraint turns that move into a
 * delete and the source row's role, seat type, upstream membership id, and
 * join provenance are gone — an unlink afterwards cannot restore them.
 * Endpoints that trigger a consolidation use this to require stated operator
 * intent first.
 *
 * Scope is the membership tables. `mergeUsers` also deduplicates
 * `learner_progress`, `user_credentials`, `committee_interest`, and
 * `user_badges`; those are records rather than authority, and refusing a
 * promote over an overlapping badge or completed module would block nearly
 * every legitimate consolidation. Callers say so in the confirmation text
 * instead of enumerating them.
 */

import { query } from './client.js';

export interface SupersededMembershipOverlap {
  /** Organizations where the source's `organization_memberships` row is deleted. */
  organizationIds: string[];
  /** Working groups where the source's `working_group_memberships` row is deleted. */
  workingGroupIds: string[];
}

/**
 * Memberships that consolidating `sourceUserId` onto `targetUserId` would
 * DELETE because the target already holds a row for the same partner key.
 *
 * Only the overlap is reported. Non-overlapping memberships move forward
 * intact, so including those would refuse every ordinary consolidation.
 */
export async function findSupersededMemberships(
  sourceUserId: string,
  targetUserId: string,
): Promise<SupersededMembershipOverlap> {
  const [organizations, workingGroups] = await Promise.all([
    query<{ workos_organization_id: string }>(
      `SELECT om.workos_organization_id
         FROM organization_memberships om
        WHERE om.workos_user_id = $1
          AND EXISTS (
            SELECT 1 FROM organization_memberships target
             WHERE target.workos_user_id = $2
               AND target.workos_organization_id = om.workos_organization_id
          )
        ORDER BY om.workos_organization_id`,
      [sourceUserId, targetUserId],
    ),
    query<{ working_group_id: string }>(
      `SELECT wgm.working_group_id
         FROM working_group_memberships wgm
        WHERE wgm.workos_user_id = $1
          AND EXISTS (
            SELECT 1 FROM working_group_memberships target
             WHERE target.workos_user_id = $2
               AND target.working_group_id = wgm.working_group_id
          )
        ORDER BY wgm.working_group_id`,
      [sourceUserId, targetUserId],
    ),
  ]);

  return {
    organizationIds: organizations.rows.map((row) => row.workos_organization_id),
    workingGroupIds: workingGroups.rows.map((row) => row.working_group_id),
  };
}
