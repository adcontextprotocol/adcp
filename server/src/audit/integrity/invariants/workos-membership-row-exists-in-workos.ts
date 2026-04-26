/**
 * Invariant (sampled): a random sample of active organization_memberships
 * rows correspond to memberships that exist in WorkOS. Catches stale rows
 * left behind when a WorkOS deletion webhook was missed or fired before
 * AAO was ready.
 *
 * Sampled because we have many memberships and full enumeration per run
 * would burn WorkOS API budget. The sample window cycles via ORDER BY
 * RANDOM(), so over many runs we cover the whole population probabilistically.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

const DEFAULT_SAMPLE_SIZE = 200;

interface MembershipRow {
  workos_user_id: string;
  workos_organization_id: string;
  workos_membership_id: string | null;
  status: string;
}

export const workosMembershipRowExistsInWorkosInvariant: Invariant = {
  name: 'workos-membership-row-exists-in-workos',
  description:
    'Random sample of active organization_memberships rows have a ' +
    'corresponding live membership in WorkOS. Catches stale rows from ' +
    'missed delete webhooks. Sampled (default 200/run) so we cycle ' +
    'through the population over multiple runs.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, workos, logger, options } = ctx;
    const sampleSize = options?.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    const violations: Violation[] = [];

    // ORDER BY RANDOM() is fine at our scale (tens of thousands of rows).
    // If membership counts grow significantly, switch to TABLESAMPLE.
    const result = await pool.query<MembershipRow>(
      `SELECT workos_user_id, workos_organization_id, workos_membership_id, status
         FROM organization_memberships
        WHERE status = 'active'
        ORDER BY RANDOM()
        LIMIT $1`,
      [sampleSize],
    );

    for (const row of result.rows) {
      try {
        const memberships = await workos.userManagement.listOrganizationMemberships({
          userId: row.workos_user_id,
          organizationId: row.workos_organization_id,
        });
        if (memberships.data.length === 0) {
          violations.push({
            invariant: 'workos-membership-row-exists-in-workos',
            severity: 'warning',
            subject_type: 'membership',
            subject_id: `${row.workos_user_id}:${row.workos_organization_id}`,
            message:
              `organization_memberships row marked active for user ${row.workos_user_id} in ` +
              `org ${row.workos_organization_id}, but WorkOS reports no such membership`,
            details: {
              workos_user_id: row.workos_user_id,
              workos_organization_id: row.workos_organization_id,
              workos_membership_id: row.workos_membership_id,
            },
            remediation_hint:
              'Either delete the stale row (if WorkOS is the source of truth and the user has been removed) ' +
              'or re-create the WorkOS membership (if AAO is the source of truth and the deletion was accidental).',
          });
        }
      } catch (err) {
        logger.warn(
          {
            err,
            userId: row.workos_user_id,
            orgId: row.workos_organization_id,
          },
          'workos-membership-row-exists-in-workos: WorkOS lookup failed',
        );
        violations.push({
          invariant: 'workos-membership-row-exists-in-workos',
          severity: 'warning',
          subject_type: 'membership',
          subject_id: `${row.workos_user_id}:${row.workos_organization_id}`,
          message: `WorkOS lookup failed for user ${row.workos_user_id} in org ${row.workos_organization_id}: ${err instanceof Error ? err.message : String(err)}`,
          details: {
            workos_user_id: row.workos_user_id,
            workos_organization_id: row.workos_organization_id,
          },
        });
      }
    }

    return { checked: result.rows.length, violations };
  },
};
