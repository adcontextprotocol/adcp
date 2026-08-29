/**
 * Consolidation checks for the credential-binding admin paths (#6827).
 *
 * `mergeUsers` moves an organization membership onto the target credential by
 * rewriting `workos_user_id`. Where the target already belongs to the same
 * organization the unique constraint forces the source row to be deleted
 * instead, and its role, seat type, and upstream WorkOS membership id are
 * gone — an unlink afterwards cannot restore them. Endpoints that trigger a
 * consolidation use this to require stated operator intent first.
 */

import { query } from './client.js';

/**
 * Organizations where consolidating `sourceUserId` onto `targetUserId` would
 * DELETE the source's membership because the target already holds one.
 *
 * Only the overlap is reported. Non-overlapping memberships move forward
 * intact, so blocking on those would refuse every ordinary consolidation.
 */
export async function findSupersededMembershipOrganizations(
  sourceUserId: string,
  targetUserId: string,
): Promise<string[]> {
  const result = await query<{ workos_organization_id: string }>(
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
  );
  return result.rows.map((row) => row.workos_organization_id);
}
