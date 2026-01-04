/**
 * Organization Merge Database Operations
 *
 * Provides functionality to merge two organizations, moving all related data
 * from a secondary organization to a primary organization.
 *
 * This is used when:
 * - Duplicate organizations are discovered
 * - Companies acquire/merge with each other
 * - Organizations need to be consolidated
 */

import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('org-merge-db');

export interface MergeSummary {
  primary_org_id: string;
  secondary_org_id: string;
  merged_by: string;
  merged_at: Date;
  tables_merged: {
    table_name: string;
    rows_moved: number;
    rows_skipped_duplicate: number;
  }[];
  prospect_notes_merged: boolean;
  enrichment_data_preserved: boolean;
  warnings: string[];
}

/**
 * Merge two organizations, moving all data from secondary to primary
 *
 * @param primaryOrgId - The organization to keep (merge into)
 * @param secondaryOrgId - The organization to remove (merge from)
 * @param mergedBy - WorkOS user ID of person initiating the merge
 * @returns Summary of the merge operation
 */
export async function mergeOrganizations(
  primaryOrgId: string,
  secondaryOrgId: string,
  mergedBy: string
): Promise<MergeSummary> {
  const pool = getPool();
  const client = await pool.connect();

  const summary: MergeSummary = {
    primary_org_id: primaryOrgId,
    secondary_org_id: secondaryOrgId,
    merged_by: mergedBy,
    merged_at: new Date(),
    tables_merged: [],
    prospect_notes_merged: false,
    enrichment_data_preserved: false,
    warnings: [],
  };

  try {
    // Start transaction
    await client.query('BEGIN');

    logger.info(
      { primaryOrgId, secondaryOrgId, mergedBy },
      'Starting organization merge'
    );

    // Validate both organizations exist and fetch all needed fields
    const orgsResult = await client.query(
      `SELECT workos_organization_id, name, prospect_notes,
              enrichment_at, enrichment_industry, enrichment_sub_industry,
              enrichment_employee_count, enrichment_revenue, enrichment_revenue_range,
              enrichment_country, enrichment_city, enrichment_description
       FROM organizations
       WHERE workos_organization_id = ANY($1)`,
      [[primaryOrgId, secondaryOrgId]]
    );

    if (orgsResult.rows.length !== 2) {
      throw new Error('Both organizations must exist');
    }

    const primaryOrg = orgsResult.rows.find(r => r.workos_organization_id === primaryOrgId);
    const secondaryOrg = orgsResult.rows.find(r => r.workos_organization_id === secondaryOrgId);

    if (!primaryOrg || !secondaryOrg) {
      throw new Error('Could not load organization details');
    }

    logger.info(
      { primary: primaryOrg.name, secondary: secondaryOrg.name },
      'Merging organizations'
    );

    // =====================================================
    // 1. Merge organization_memberships
    // =====================================================
    const membershipsResult = await client.query(
      `INSERT INTO organization_memberships (
        workos_user_id, workos_organization_id, workos_membership_id,
        email, first_name, last_name, created_at, updated_at, synced_at
      )
      SELECT
        workos_user_id, $1, workos_membership_id,
        email, first_name, last_name, created_at, updated_at, synced_at
      FROM organization_memberships
      WHERE workos_organization_id = $2
      ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING
      RETURNING workos_user_id`,
      [primaryOrgId, secondaryOrgId]
    );

    const skippedMemberships = await client.query(
      `SELECT COUNT(*) as count FROM organization_memberships
       WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'organization_memberships',
      rows_moved: membershipsResult.rows.length,
      rows_skipped_duplicate: parseInt(skippedMemberships.rows[0].count, 10) - membershipsResult.rows.length,
    });

    // Delete secondary org memberships
    await client.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    // =====================================================
    // 2. Merge organization_domains
    // =====================================================
    const domainsResult = await client.query(
      `INSERT INTO organization_domains (
        workos_organization_id, domain, is_primary, verified, source,
        created_at, updated_at
      )
      SELECT
        $1, domain, false, verified, source, created_at, updated_at
      FROM organization_domains
      WHERE workos_organization_id = $2
      ON CONFLICT (domain) DO NOTHING
      RETURNING domain`,
      [primaryOrgId, secondaryOrgId]
    );

    const totalDomains = await client.query(
      `SELECT COUNT(*) as count FROM organization_domains
       WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'organization_domains',
      rows_moved: domainsResult.rows.length,
      rows_skipped_duplicate: parseInt(totalDomains.rows[0].count, 10) - domainsResult.rows.length,
    });

    // Delete secondary org domains
    await client.query(
      `DELETE FROM organization_domains WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    // =====================================================
    // 3. Merge organization_join_requests
    // =====================================================
    const joinRequestsResult = await client.query(
      `UPDATE organization_join_requests
       SET workos_organization_id = $1, updated_at = NOW()
       WHERE workos_organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'organization_join_requests',
      rows_moved: joinRequestsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 4. Merge working_group_memberships
    // =====================================================
    const wgMembershipsResult = await client.query(
      `INSERT INTO working_group_memberships (
        working_group_id, workos_user_id, user_email, user_name, user_org_name,
        workos_organization_id, status, added_by_user_id, joined_at, updated_at
      )
      SELECT
        working_group_id, workos_user_id, user_email, user_name, user_org_name,
        $1, status, added_by_user_id, joined_at, updated_at
      FROM working_group_memberships
      WHERE workos_organization_id = $2
      ON CONFLICT (working_group_id, workos_user_id) DO NOTHING
      RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    const totalWgMemberships = await client.query(
      `SELECT COUNT(*) as count FROM working_group_memberships
       WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'working_group_memberships',
      rows_moved: wgMembershipsResult.rows.length,
      rows_skipped_duplicate: parseInt(totalWgMemberships.rows[0].count, 10) - wgMembershipsResult.rows.length,
    });

    // Delete secondary org WG memberships
    await client.query(
      `DELETE FROM working_group_memberships WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    // =====================================================
    // 5. Merge member_profiles (if exists)
    // =====================================================
    const primaryProfile = await client.query(
      `SELECT id FROM member_profiles WHERE workos_organization_id = $1`,
      [primaryOrgId]
    );

    if (primaryProfile.rows.length === 0) {
      // Primary has no profile, move secondary's if it exists
      const profileResult = await client.query(
        `UPDATE member_profiles
         SET workos_organization_id = $1, updated_at = NOW()
         WHERE workos_organization_id = $2
         RETURNING id`,
        [primaryOrgId, secondaryOrgId]
      );

      summary.tables_merged.push({
        table_name: 'member_profiles',
        rows_moved: profileResult.rows.length,
        rows_skipped_duplicate: 0,
      });
    } else {
      // Primary has profile, delete secondary's
      const secondaryProfile = await client.query(
        `DELETE FROM member_profiles WHERE workos_organization_id = $1 RETURNING id`,
        [secondaryOrgId]
      );

      if (secondaryProfile.rows.length > 0) {
        summary.warnings.push('Secondary organization had a member profile which was deleted (primary profile kept)');
      }

      summary.tables_merged.push({
        table_name: 'member_profiles',
        rows_moved: 0,
        rows_skipped_duplicate: secondaryProfile.rows.length,
      });
    }

    // =====================================================
    // 6. Merge org_activities
    // =====================================================
    const activitiesResult = await client.query(
      `UPDATE org_activities
       SET organization_id = $1, updated_at = NOW()
       WHERE organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'org_activities',
      rows_moved: activitiesResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 7. Merge org_stakeholders
    // =====================================================
    const stakeholdersResult = await client.query(
      `INSERT INTO org_stakeholders (
        organization_id, user_id, user_name, user_email, role, notes,
        created_at, updated_at
      )
      SELECT
        $1, user_id, user_name, user_email, role, notes, created_at, updated_at
      FROM org_stakeholders
      WHERE organization_id = $2
      ON CONFLICT (organization_id, user_id) DO NOTHING
      RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    const totalStakeholders = await client.query(
      `SELECT COUNT(*) as count FROM org_stakeholders WHERE organization_id = $1`,
      [secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'org_stakeholders',
      rows_moved: stakeholdersResult.rows.length,
      rows_skipped_duplicate: parseInt(totalStakeholders.rows[0].count, 10) - stakeholdersResult.rows.length,
    });

    // Delete secondary org stakeholders
    await client.query(
      `DELETE FROM org_stakeholders WHERE organization_id = $1`,
      [secondaryOrgId]
    );

    // =====================================================
    // 8. Merge slack_activity_daily
    // =====================================================
    const slackActivityResult = await client.query(
      `UPDATE slack_activity_daily
       SET organization_id = $1, updated_at = NOW()
       WHERE organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'slack_activity_daily',
      rows_moved: slackActivityResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 9. Merge slack_user_mappings (update org context)
    // Note: This doesn't have a direct FK, but we update for consistency
    // =====================================================
    // No direct FK to organizations in slack_user_mappings, skip

    // =====================================================
    // 10. Merge email_events
    // =====================================================
    const emailEventsResult = await client.query(
      `UPDATE email_events
       SET workos_organization_id = $1, updated_at = NOW()
       WHERE workos_organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'email_events',
      rows_moved: emailEventsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 11. Merge email_contacts
    // =====================================================
    const emailContactsResult = await client.query(
      `UPDATE email_contacts
       SET organization_id = $1, updated_at = NOW()
       WHERE organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'email_contacts',
      rows_moved: emailContactsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 12. Merge addie_threads (update org context in JSON)
    // Note: addie_threads doesn't have a direct FK but may reference org in context
    // =====================================================
    const addieThreadsResult = await client.query(
      `UPDATE addie_threads
       SET context = jsonb_set(
         COALESCE(context, '{}'::jsonb),
         '{organization_id}',
         to_jsonb($1::text)
       ),
       updated_at = NOW()
       WHERE context->>'organization_id' = $2
       RETURNING thread_id`,
      [primaryOrgId, secondaryOrgId]
    );

    if (addieThreadsResult.rows.length > 0) {
      summary.tables_merged.push({
        table_name: 'addie_threads',
        rows_moved: addieThreadsResult.rows.length,
        rows_skipped_duplicate: 0,
      });
    }

    // =====================================================
    // 13. Merge action_items
    // =====================================================
    const actionItemsResult = await client.query(
      `UPDATE action_items
       SET org_id = $1, updated_at = NOW()
       WHERE org_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'action_items',
      rows_moved: actionItemsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 14. Merge revenue_events (payment history)
    // =====================================================
    const revenueEventsResult = await client.query(
      `UPDATE revenue_events
       SET workos_organization_id = $1
       WHERE workos_organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'revenue_events',
      rows_moved: revenueEventsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 15. Merge subscription_line_items
    // =====================================================
    const lineItemsResult = await client.query(
      `UPDATE subscription_line_items
       SET workos_organization_id = $1, updated_at = NOW()
       WHERE workos_organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'subscription_line_items',
      rows_moved: lineItemsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 16. Merge event_registrations
    // =====================================================
    const eventRegsResult = await client.query(
      `UPDATE event_registrations
       SET organization_id = $1, updated_at = NOW()
       WHERE organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'event_registrations',
      rows_moved: eventRegsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 17. Merge event_sponsorships
    // =====================================================
    const sponsorshipsResult = await client.query(
      `UPDATE event_sponsorships
       SET organization_id = $1, updated_at = NOW()
       WHERE organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'event_sponsorships',
      rows_moved: sponsorshipsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 18. Merge user_agreement_acceptances
    // =====================================================
    const agreementsResult = await client.query(
      `UPDATE user_agreement_acceptances
       SET workos_organization_id = $1
       WHERE workos_organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'user_agreement_acceptances',
      rows_moved: agreementsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 19. Merge org_admin_group_dms (Slack admin channels)
    // Note: ON DELETE CASCADE handles this, but we track it explicitly
    // =====================================================
    const adminDmsResult = await client.query(
      `DELETE FROM org_admin_group_dms WHERE workos_organization_id = $1 RETURNING id`,
      [secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'org_admin_group_dms',
      rows_moved: 0,
      rows_skipped_duplicate: adminDmsResult.rows.length, // Deleted, not moved
    });

    if (adminDmsResult.rows.length > 0) {
      summary.warnings.push('Secondary org had a Slack admin DM channel which was removed (primary channel kept if exists)');
    }

    // =====================================================
    // 20. Merge registry_audit_log entries
    // =====================================================
    const auditLogResult = await client.query(
      `UPDATE registry_audit_log
       SET workos_organization_id = $1
       WHERE workos_organization_id = $2
       RETURNING id`,
      [primaryOrgId, secondaryOrgId]
    );

    summary.tables_merged.push({
      table_name: 'registry_audit_log',
      rows_moved: auditLogResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 21. Merge prospect notes
    // =====================================================
    if (secondaryOrg.prospect_notes && secondaryOrg.prospect_notes.trim()) {
      const timestamp = new Date().toISOString().split('T')[0];
      const mergeNote = `[${timestamp}] MERGED FROM: ${secondaryOrg.name}\n${secondaryOrg.prospect_notes}`;

      await client.query(
        `UPDATE organizations
         SET prospect_notes = CASE
           WHEN prospect_notes IS NULL OR prospect_notes = '' THEN $2
           ELSE prospect_notes || E'\n\n' || $2
         END,
         updated_at = NOW()
         WHERE workos_organization_id = $1`,
        [primaryOrgId, mergeNote]
      );

      summary.prospect_notes_merged = true;
    }

    // =====================================================
    // 22. Preserve enrichment data if primary doesn't have it
    // =====================================================
    if (secondaryOrg.enrichment_at && !primaryOrg.enrichment_at) {
      await client.query(
        `UPDATE organizations
         SET enrichment_at = $2,
             enrichment_industry = $3,
             enrichment_sub_industry = $4,
             enrichment_employee_count = $5,
             enrichment_revenue = $6,
             enrichment_revenue_range = $7,
             enrichment_country = $8,
             enrichment_city = $9,
             enrichment_description = $10,
             updated_at = NOW()
         WHERE workos_organization_id = $1`,
        [
          primaryOrgId,
          secondaryOrg.enrichment_at,
          secondaryOrg.enrichment_industry,
          secondaryOrg.enrichment_sub_industry || null,
          secondaryOrg.enrichment_employee_count || null,
          secondaryOrg.enrichment_revenue || null,
          secondaryOrg.enrichment_revenue_range || null,
          secondaryOrg.enrichment_country || null,
          secondaryOrg.enrichment_city || null,
          secondaryOrg.enrichment_description || null,
        ]
      );

      summary.enrichment_data_preserved = true;
      summary.warnings.push('Enrichment data from secondary organization was copied to primary');
    }

    // =====================================================
    // 23. Log the merge action in audit log
    // =====================================================
    await client.query(
      `INSERT INTO registry_audit_log (
        workos_organization_id, workos_user_id, action, resource_type, resource_id, details
      ) VALUES ($1, $2, 'merge_organization', 'organization', $3, $4)`,
      [
        primaryOrgId,
        mergedBy,
        secondaryOrgId,
        JSON.stringify({
          secondary_org_name: secondaryOrg.name,
          primary_org_name: primaryOrg.name,
          merged_at: summary.merged_at,
          tables_affected: summary.tables_merged.map(t => t.table_name),
        }),
      ]
    );

    // =====================================================
    // 24. Delete the secondary organization
    // =====================================================
    await client.query(
      `DELETE FROM organizations WHERE workos_organization_id = $1`,
      [secondaryOrgId]
    );

    // Commit transaction
    await client.query('COMMIT');

    logger.info(
      {
        primaryOrgId,
        secondaryOrgId,
        totalMoved: summary.tables_merged.reduce((sum, t) => sum + t.rows_moved, 0),
      },
      'Organization merge completed successfully'
    );

    return summary;
  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');

    logger.error(
      { error, primaryOrgId, secondaryOrgId },
      'Organization merge failed, rolled back'
    );

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get a preview of what would be merged without actually performing the merge
 *
 * @param primaryOrgId - The organization to keep
 * @param secondaryOrgId - The organization to remove
 * @returns Preview of merge operation
 */
export async function previewMerge(
  primaryOrgId: string,
  secondaryOrgId: string
): Promise<{
  primary_org: { id: string; name: string };
  secondary_org: { id: string; name: string };
  estimated_changes: {
    table_name: string;
    rows_to_move: number;
  }[];
  warnings: string[];
}> {
  const pool = getPool();

  // Get organization names
  const orgsResult = await pool.query(
    `SELECT workos_organization_id, name FROM organizations
     WHERE workos_organization_id = ANY($1)`,
    [[primaryOrgId, secondaryOrgId]]
  );

  if (orgsResult.rows.length !== 2) {
    throw new Error('Both organizations must exist');
  }

  const primaryOrg = orgsResult.rows.find(r => r.workos_organization_id === primaryOrgId);
  const secondaryOrg = orgsResult.rows.find(r => r.workos_organization_id === secondaryOrgId);

  if (!primaryOrg || !secondaryOrg) {
    throw new Error('Could not load organization details');
  }

  const warnings: string[] = [];
  const estimatedChanges: { table_name: string; rows_to_move: number }[] = [];

  // Count rows in each table
  const tables = [
    { table: 'organization_memberships', column: 'workos_organization_id' },
    { table: 'organization_domains', column: 'workos_organization_id' },
    { table: 'organization_join_requests', column: 'workos_organization_id' },
    { table: 'working_group_memberships', column: 'workos_organization_id' },
    { table: 'member_profiles', column: 'workos_organization_id' },
    { table: 'org_activities', column: 'organization_id' },
    { table: 'org_stakeholders', column: 'organization_id' },
    { table: 'slack_activity_daily', column: 'organization_id' },
    { table: 'email_events', column: 'workos_organization_id' },
    { table: 'email_contacts', column: 'organization_id' },
    { table: 'action_items', column: 'org_id' },
    { table: 'registry_audit_log', column: 'workos_organization_id' },
    { table: 'revenue_events', column: 'workos_organization_id' },
    { table: 'subscription_line_items', column: 'workos_organization_id' },
    { table: 'event_registrations', column: 'organization_id' },
    { table: 'event_sponsorships', column: 'organization_id' },
    { table: 'user_agreement_acceptances', column: 'workos_organization_id' },
    { table: 'org_admin_group_dms', column: 'workos_organization_id' },
  ];

  for (const { table, column } of tables) {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${column} = $1`,
      [secondaryOrgId]
    );

    const count = parseInt(result.rows[0].count, 10);
    if (count > 0) {
      estimatedChanges.push({
        table_name: table,
        rows_to_move: count,
      });
    }
  }

  // Check for membership being moved - warn if secondary has members
  const membershipCheck = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM organization_memberships WHERE workos_organization_id = $1) as primary_count,
       (SELECT COUNT(*) FROM organization_memberships WHERE workos_organization_id = $2) as secondary_count`,
    [primaryOrgId, secondaryOrgId]
  );

  const primaryMemberCount = parseInt(membershipCheck.rows[0].primary_count, 10);
  const secondaryMemberCount = parseInt(membershipCheck.rows[0].secondary_count, 10);

  if (secondaryMemberCount > 0 && primaryMemberCount === 0) {
    warnings.push(`⚠️ The secondary org has ${secondaryMemberCount} member(s) while the primary has none. Consider swapping which org is primary.`);
  } else if (secondaryMemberCount > primaryMemberCount) {
    warnings.push(`⚠️ The secondary org has more members (${secondaryMemberCount}) than the primary (${primaryMemberCount}). Consider swapping which org is primary.`);
  }

  // Check for member profile conflict
  const profileCheck = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM member_profiles WHERE workos_organization_id = $1) as primary_count,
       (SELECT COUNT(*) FROM member_profiles WHERE workos_organization_id = $2) as secondary_count`,
    [primaryOrgId, secondaryOrgId]
  );

  if (profileCheck.rows[0].primary_count > 0 && profileCheck.rows[0].secondary_count > 0) {
    warnings.push('Both organizations have member profiles - secondary profile will be deleted');
  }

  // Check for Stripe conflicts
  const stripeCheck = await pool.query(
    `SELECT
       workos_organization_id, stripe_customer_id, stripe_subscription_id, subscription_status
     FROM organizations
     WHERE workos_organization_id = ANY($1)`,
    [[primaryOrgId, secondaryOrgId]]
  );

  const secondaryStripe = stripeCheck.rows.find(r => r.workos_organization_id === secondaryOrgId);

  if (secondaryStripe?.stripe_customer_id) {
    warnings.push(`⚠️ STRIPE: Secondary org has Stripe customer ${secondaryStripe.stripe_customer_id} - this will NOT be merged automatically. Manual Stripe cleanup required.`);
  }

  if (secondaryStripe?.stripe_subscription_id) {
    const status = secondaryStripe.subscription_status || 'unknown';
    warnings.push(`⚠️ STRIPE: Secondary org has subscription ${secondaryStripe.stripe_subscription_id} (status: ${status}) - cancel in Stripe before merging`);
  }

  // Check for admin DM channel conflict
  const adminDmCheck = await pool.query(
    `SELECT workos_organization_id FROM org_admin_group_dms WHERE workos_organization_id = ANY($1)`,
    [[primaryOrgId, secondaryOrgId]]
  );

  if (adminDmCheck.rows.length === 2) {
    warnings.push('Both organizations have Slack admin DM channels - secondary channel will be removed');
  }

  return {
    primary_org: { id: primaryOrg.workos_organization_id, name: primaryOrg.name },
    secondary_org: { id: secondaryOrg.workos_organization_id, name: secondaryOrg.name },
    estimated_changes: estimatedChanges,
    warnings,
  };
}
