/**
 * User Account Merge Database Operations
 *
 * Merges two user accounts (identified by workos_user_id), moving all data
 * from a secondary user to a primary user. Used when a user has duplicate
 * accounts from signing up with different emails.
 *
 * Follows the same transactional pattern as org-merge-db.ts.
 */

import { getPool } from './client.js';
import { createLogger } from '../logger.js';
import type { WorkOS } from '@workos-inc/node';

const logger = createLogger('user-merge-db');

export interface UserMergeSummary {
  primary_user_id: string;
  secondary_user_id: string;
  merged_by: string;
  merged_at: Date;
  tables_merged: {
    table_name: string;
    rows_moved: number;
    rows_skipped_duplicate: number;
  }[];
  workos_user_deleted: boolean;
  warnings: string[];
}

export interface UserMergePreview {
  primary_user_id: string;
  secondary_user_id: string;
  tables: {
    table_name: string;
    row_count: number;
  }[];
}

/**
 * Preview what a user merge would do without modifying data.
 */
export async function previewUserMerge(
  primaryUserId: string,
  secondaryUserId: string
): Promise<UserMergePreview> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const preview: UserMergePreview = {
      primary_user_id: primaryUserId,
      secondary_user_id: secondaryUserId,
      tables: [],
    };

    // Keep this list in sync with mergeUsers() below
    const tables = [
      { name: 'organization_memberships', col: 'workos_user_id' },
      { name: 'working_group_memberships', col: 'workos_user_id' },
      { name: 'learner_progress', col: 'workos_user_id' },
      { name: 'certification_attempts', col: 'workos_user_id' },
      { name: 'user_credentials', col: 'workos_user_id' },
      { name: 'teaching_checkpoints', col: 'workos_user_id' },
      { name: 'certification_learner_feedback', col: 'workos_user_id' },
      { name: 'user_email_preferences', col: 'workos_user_id' },
      { name: 'committee_interest', col: 'workos_user_id' },
      { name: 'user_badges', col: 'workos_user_id' },
      { name: 'person_relationships', col: 'workos_user_id' },
      { name: 'community_points', col: 'workos_user_id' },
      { name: 'connections', col: 'requester_user_id' },
      { name: 'connections', col: 'recipient_user_id' },
      { name: 'flagged_conversations', col: 'reviewed_by' },
      { name: 'slack_user_mappings', col: 'workos_user_id' },
      { name: 'email_contacts', col: 'workos_user_id' },
      { name: 'email_events', col: 'workos_user_id' },
      { name: 'event_registrations', col: 'workos_user_id' },
      { name: 'event_sponsorships', col: 'purchased_by_user_id' },
      { name: 'events', col: 'created_by_user_id' },
      { name: 'addie_escalations', col: 'workos_user_id' },
      { name: 'action_items', col: 'workos_user_id' },
      { name: 'user_stakeholders', col: 'workos_user_id' },
      { name: 'user_agreement_acceptances', col: 'workos_user_id' },
      { name: 'member_insights', col: 'workos_user_id' },
      { name: 'working_group_topic_subscriptions', col: 'workos_user_id' },
      { name: 'meeting_attendees', col: 'workos_user_id' },
      { name: 'organization_join_requests', col: 'workos_user_id' },
      { name: 'known_media_contacts', col: 'added_by' },
      { name: 'member_portraits', col: 'user_id' },
      { name: 'seat_upgrade_requests', col: 'workos_user_id' },
      { name: 'user_email_aliases', col: 'workos_user_id' },
      { name: 'email_link_tokens', col: 'primary_workos_user_id' },
    ];

    for (const table of tables) {
      const result = await client.query(
        `SELECT COUNT(*) as count FROM ${table.name} WHERE ${table.col} = $1`,
        [secondaryUserId]
      );
      const count = parseInt(result.rows[0].count, 10);
      if (count > 0) {
        preview.tables.push({ table_name: table.name, row_count: count });
      }
    }

    return preview;
  } finally {
    client.release();
  }
}

/**
 * Merge two user accounts, moving all data from secondary to primary.
 *
 * @param primaryUserId - The WorkOS user ID to keep (merge into)
 * @param secondaryUserId - The WorkOS user ID to remove (merge from)
 * @param mergedBy - WorkOS user ID of person initiating the merge
 * @param workos - WorkOS client instance for deleting the secondary user
 */
export async function mergeUsers(
  primaryUserId: string,
  secondaryUserId: string,
  mergedBy: string,
  workos: WorkOS
): Promise<UserMergeSummary> {
  const pool = getPool();
  const client = await pool.connect();

  const summary: UserMergeSummary = {
    primary_user_id: primaryUserId,
    secondary_user_id: secondaryUserId,
    merged_by: mergedBy,
    merged_at: new Date(),
    tables_merged: [],
    workos_user_deleted: false,
    warnings: [],
  };

  try {
    await client.query('BEGIN');

    logger.info(
      { primaryUserId, secondaryUserId, mergedBy },
      'Starting user merge'
    );

    // Validate both users exist
    const usersResult = await client.query(
      `SELECT workos_user_id, email, first_name, last_name, created_at
       FROM users WHERE workos_user_id = ANY($1)`,
      [[primaryUserId, secondaryUserId]]
    );

    if (usersResult.rows.length < 2) {
      // Only one user found — the other might not exist in our users table
      // This is OK if the secondary user was only created via working group membership
      const primaryExists = usersResult.rows.some(r => r.workos_user_id === primaryUserId);
      if (!primaryExists) {
        throw new Error('Primary user does not exist');
      }
      // Secondary might not have a users row, which is fine
    }

    // Helper to merge a table with UNIQUE constraint.
    // Updates workos_user_id for rows that won't conflict, deletes the rest.
    // uniquePartnerCol is the other column in the UNIQUE(workos_user_id, X) constraint.
    async function mergeWithConflict(
      tableName: string,
      uniquePartnerCol: string
    ): Promise<void> {
      const totalResult = await client.query(
        `SELECT COUNT(*) as count FROM ${tableName} WHERE workos_user_id = $1`,
        [secondaryUserId]
      );
      const totalCount = parseInt(totalResult.rows[0].count, 10);

      if (totalCount === 0) {
        summary.tables_merged.push({ table_name: tableName, rows_moved: 0, rows_skipped_duplicate: 0 });
        return;
      }

      // Update rows that won't conflict (partner value doesn't exist for primary)
      const updateResult = await client.query(
        `UPDATE ${tableName} SET workos_user_id = $1
         WHERE workos_user_id = $2
         AND ${uniquePartnerCol} NOT IN (
           SELECT ${uniquePartnerCol} FROM ${tableName} WHERE workos_user_id = $1
         )
         RETURNING 1`,
        [primaryUserId, secondaryUserId]
      );

      // Delete remaining secondary rows (duplicates)
      await client.query(
        `DELETE FROM ${tableName} WHERE workos_user_id = $1`,
        [secondaryUserId]
      );

      summary.tables_merged.push({
        table_name: tableName,
        rows_moved: updateResult.rows.length,
        rows_skipped_duplicate: totalCount - updateResult.rows.length,
      });
    }

    // Helper to merge a table with simple UPDATE
    async function mergeWithUpdate(tableName: string, column = 'workos_user_id'): Promise<void> {
      const result = await client.query(
        `UPDATE ${tableName} SET ${column} = $1 WHERE ${column} = $2 RETURNING 1`,
        [primaryUserId, secondaryUserId]
      );

      summary.tables_merged.push({
        table_name: tableName,
        rows_moved: result.rows.length,
        rows_skipped_duplicate: 0,
      });
    }

    // =====================================================
    // 1. Tables with UNIQUE constraints (INSERT...ON CONFLICT)
    // =====================================================

    // organization_memberships: UNIQUE(workos_user_id, workos_organization_id)
    await mergeWithConflict('organization_memberships', 'workos_organization_id');

    // working_group_memberships: UNIQUE(working_group_id, workos_user_id)
    await mergeWithConflict('working_group_memberships', 'working_group_id');

    // learner_progress: UNIQUE(workos_user_id, module_id)
    await mergeWithConflict('learner_progress', 'module_id');

    // user_credentials: UNIQUE(workos_user_id, credential_id)
    await mergeWithConflict('user_credentials', 'credential_id');

    // committee_interest: UNIQUE(working_group_id, workos_user_id)
    await mergeWithConflict('committee_interest', 'working_group_id');

    // user_badges: UNIQUE(workos_user_id, badge_id)
    await mergeWithConflict('user_badges', 'badge_id');

    // user_email_preferences: UNIQUE(workos_user_id) — keep primary's, delete secondary's
    const secondaryPrefs = await client.query(
      `DELETE FROM user_email_preferences WHERE workos_user_id = $1 RETURNING 1`,
      [secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'user_email_preferences',
      rows_moved: 0,
      rows_skipped_duplicate: secondaryPrefs.rows.length,
    });

    // person_relationships: UNIQUE(workos_user_id) — keep primary's, delete secondary's
    const primaryRelExists = await client.query(
      `SELECT 1 FROM person_relationships WHERE workos_user_id = $1`,
      [primaryUserId]
    );
    if (primaryRelExists.rows.length > 0) {
      const deleted = await client.query(
        `DELETE FROM person_relationships WHERE workos_user_id = $1 RETURNING 1`,
        [secondaryUserId]
      );
      summary.tables_merged.push({
        table_name: 'person_relationships',
        rows_moved: 0,
        rows_skipped_duplicate: deleted.rows.length,
      });
    } else {
      await mergeWithUpdate('person_relationships');
    }

    // =====================================================
    // 2. Tables with UNIQUE constraints needing conflict handling
    // =====================================================

    // event_registrations: UNIQUE(event_id, workos_user_id)
    await mergeWithConflict('event_registrations', 'event_id');

    // user_stakeholders: UNIQUE(workos_user_id, stakeholder_id)
    await mergeWithConflict('user_stakeholders', 'stakeholder_id');

    // working_group_topic_subscriptions: UNIQUE(working_group_id, workos_user_id)
    await mergeWithConflict('working_group_topic_subscriptions', 'working_group_id');

    // meeting_attendees: UNIQUE(meeting_id, workos_user_id)
    await mergeWithConflict('meeting_attendees', 'meeting_id');

    // user_agreement_acceptances: UNIQUE(workos_user_id, agreement_type, agreement_version)
    // Composite unique — delete secondary's duplicates first, then update rest
    const agreementTotalResult = await client.query(
      `SELECT COUNT(*) as count FROM user_agreement_acceptances WHERE workos_user_id = $1`,
      [secondaryUserId]
    );
    const agreementTotal = parseInt(agreementTotalResult.rows[0].count, 10);
    await client.query(
      `DELETE FROM user_agreement_acceptances
       WHERE workos_user_id = $2
       AND (agreement_type, agreement_version) IN (
         SELECT agreement_type, agreement_version FROM user_agreement_acceptances WHERE workos_user_id = $1
       )`,
      [primaryUserId, secondaryUserId]
    );
    const agreementUpdateResult = await client.query(
      `UPDATE user_agreement_acceptances SET workos_user_id = $1 WHERE workos_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'user_agreement_acceptances',
      rows_moved: agreementUpdateResult.rows.length,
      rows_skipped_duplicate: agreementTotal - agreementUpdateResult.rows.length,
    });

    // community_points: partial UNIQUE(workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
    // Delete secondary's duplicates where reference_id matches, then update rest
    const communityTotalResult = await client.query(
      `SELECT COUNT(*) as count FROM community_points WHERE workos_user_id = $1`,
      [secondaryUserId]
    );
    const communityTotal = parseInt(communityTotalResult.rows[0].count, 10);
    await client.query(
      `DELETE FROM community_points
       WHERE workos_user_id = $2
       AND reference_id IS NOT NULL
       AND (action, reference_id) IN (
         SELECT action, reference_id FROM community_points WHERE workos_user_id = $1 AND reference_id IS NOT NULL
       )`,
      [primaryUserId, secondaryUserId]
    );
    const communityUpdateResult = await client.query(
      `UPDATE community_points SET workos_user_id = $1 WHERE workos_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'community_points',
      rows_moved: communityUpdateResult.rows.length,
      rows_skipped_duplicate: communityTotal - communityUpdateResult.rows.length,
    });

    // =====================================================
    // 3. Tables with simple UPDATE (no unique constraint on user_id)
    // =====================================================
    await mergeWithUpdate('certification_attempts');
    await mergeWithUpdate('teaching_checkpoints');
    await mergeWithUpdate('certification_learner_feedback');
    await mergeWithUpdate('flagged_conversations', 'reviewed_by');
    await mergeWithUpdate('email_contacts');
    await mergeWithUpdate('email_events');
    await mergeWithUpdate('addie_escalations');
    await mergeWithUpdate('action_items');
    await mergeWithUpdate('member_insights');
    await mergeWithUpdate('organization_join_requests');
    await mergeWithUpdate('seat_upgrade_requests');

    // connections: has CHECK(requester_user_id != recipient_user_id) and
    // UNIQUE(requester_user_id, recipient_user_id). Must handle self-connections
    // and duplicate connections carefully.
    const connResult1 = await client.query(
      `UPDATE connections SET requester_user_id = $1
       WHERE requester_user_id = $2 AND recipient_user_id != $1
       AND NOT EXISTS (
         SELECT 1 FROM connections c2
         WHERE c2.requester_user_id = $1 AND c2.recipient_user_id = connections.recipient_user_id
       )
       RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    const connResult2 = await client.query(
      `UPDATE connections SET recipient_user_id = $1
       WHERE recipient_user_id = $2 AND requester_user_id != $1
       AND NOT EXISTS (
         SELECT 1 FROM connections c2
         WHERE c2.recipient_user_id = $1 AND c2.requester_user_id = connections.requester_user_id
       )
       RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    // Delete any remaining rows (self-connections or duplicates)
    await client.query(
      `DELETE FROM connections WHERE requester_user_id = $1 OR recipient_user_id = $1`,
      [secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'connections',
      rows_moved: connResult1.rows.length + connResult2.rows.length,
      rows_skipped_duplicate: 0,
    });

    // event_sponsorships has purchased_by_user_id
    const sponsorResult = await client.query(
      `UPDATE event_sponsorships SET purchased_by_user_id = $1 WHERE purchased_by_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'event_sponsorships (purchased_by)',
      rows_moved: sponsorResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // events has created_by_user_id
    const eventsResult = await client.query(
      `UPDATE events SET created_by_user_id = $1 WHERE created_by_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'events (created_by)',
      rows_moved: eventsResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // slack_user_mappings: update workos_user_id where it points to secondary
    const slackResult = await client.query(
      `UPDATE slack_user_mappings SET workos_user_id = $1 WHERE workos_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'slack_user_mappings',
      rows_moved: slackResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // working_group_leaders
    const wgLeaderResult = await client.query(
      `UPDATE working_group_leaders SET user_id = $1 WHERE user_id = $2
       AND working_group_id NOT IN (SELECT working_group_id FROM working_group_leaders WHERE user_id = $1)
       RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    await client.query(
      `DELETE FROM working_group_leaders WHERE user_id = $1`,
      [secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'working_group_leaders',
      rows_moved: wgLeaderResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // known_media_contacts: FK added_by REFERENCES users(workos_user_id) — no CASCADE
    const mediaContactResult = await client.query(
      `UPDATE known_media_contacts SET added_by = $1 WHERE added_by = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'known_media_contacts',
      rows_moved: mediaContactResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // member_portraits: FK user_id REFERENCES users(workos_user_id) — no CASCADE
    // Keep primary's portrait if it exists, delete secondary's
    const primaryPortrait = await client.query(
      `SELECT 1 FROM member_portraits WHERE user_id = $1`,
      [primaryUserId]
    );
    if (primaryPortrait.rows.length > 0) {
      // Clear the users.portrait_id FK before deleting the portrait
      await client.query(
        `UPDATE users SET portrait_id = NULL WHERE workos_user_id = $1
         AND portrait_id IN (SELECT id FROM member_portraits WHERE user_id = $1)`,
        [secondaryUserId]
      );
      const deletedPortraits = await client.query(
        `DELETE FROM member_portraits WHERE user_id = $1 RETURNING 1`,
        [secondaryUserId]
      );
      summary.tables_merged.push({
        table_name: 'member_portraits',
        rows_moved: 0,
        rows_skipped_duplicate: deletedPortraits.rows.length,
      });
    } else {
      await client.query(
        `UPDATE member_portraits SET user_id = $1 WHERE user_id = $2`,
        [primaryUserId, secondaryUserId]
      );
      // Also update the portrait_id reference on the primary user
      const movedPortrait = await client.query(
        `SELECT id FROM member_portraits WHERE user_id = $1`,
        [primaryUserId]
      );
      if (movedPortrait.rows.length > 0) {
        await client.query(
          `UPDATE users SET portrait_id = $1 WHERE workos_user_id = $2`,
          [movedPortrait.rows[0].id, primaryUserId]
        );
      }
      summary.tables_merged.push({
        table_name: 'member_portraits',
        rows_moved: movedPortrait.rows.length,
        rows_skipped_duplicate: 0,
      });
    }

    // user_email_aliases: UNIQUE(workos_user_id, email) + UNIQUE(LOWER(email))
    // Move non-conflicting aliases, delete duplicates. Must happen before
    // DELETE FROM users (which would CASCADE-delete them).
    const aliasTotalResult = await client.query(
      `SELECT COUNT(*) as count FROM user_email_aliases WHERE workos_user_id = $1`,
      [secondaryUserId]
    );
    const aliasTotal = parseInt(aliasTotalResult.rows[0].count, 10);
    // Delete secondary aliases that conflict case-insensitively with primary's
    await client.query(
      `DELETE FROM user_email_aliases
       WHERE workos_user_id = $2
       AND LOWER(email) IN (
         SELECT LOWER(email) FROM user_email_aliases WHERE workos_user_id = $1
       )`,
      [primaryUserId, secondaryUserId]
    );
    const aliasUpdateResult = await client.query(
      `UPDATE user_email_aliases SET workos_user_id = $1 WHERE workos_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'user_email_aliases',
      rows_moved: aliasUpdateResult.rows.length,
      rows_skipped_duplicate: aliasTotal - aliasUpdateResult.rows.length,
    });

    // email_link_tokens: CASCADE-deletes when secondary user is removed.
    // Reassign any tokens where the secondary was the initiator, so they
    // stay visible in the primary's account history.
    const tokenUpdateResult = await client.query(
      `UPDATE email_link_tokens SET primary_workos_user_id = $1
       WHERE primary_workos_user_id = $2 RETURNING 1`,
      [primaryUserId, secondaryUserId]
    );
    summary.tables_merged.push({
      table_name: 'email_link_tokens',
      rows_moved: tokenUpdateResult.rows.length,
      rows_skipped_duplicate: 0,
    });

    // =====================================================
    // 3. Update champion references in organizations
    // =====================================================
    await client.query(
      `UPDATE organizations SET champion_workos_user_id = $1
       WHERE champion_workos_user_id = $2`,
      [primaryUserId, secondaryUserId]
    );

    // =====================================================
    // 4. Delete secondary user from local DB
    // =====================================================
    await client.query(
      `DELETE FROM users WHERE workos_user_id = $1`,
      [secondaryUserId]
    );

    // =====================================================
    // 5. Audit log
    // =====================================================
    // Get an org for the audit log (required NOT NULL column)
    const primaryOrgResult = await client.query(
      `SELECT workos_organization_id FROM organization_memberships
       WHERE workos_user_id = $1 LIMIT 1`,
      [primaryUserId]
    );
    const auditOrgId = primaryOrgResult.rows[0]?.workos_organization_id || 'system';

    await client.query(
      `INSERT INTO registry_audit_log (
        workos_organization_id, workos_user_id, action, resource_type, resource_id, details
      ) VALUES ($1, $2, 'merge_user', 'user', $3, $4)`,
      [
        auditOrgId,
        mergedBy,
        secondaryUserId,
        JSON.stringify({
          primary_user_id: primaryUserId,
          secondary_user_id: secondaryUserId,
          merged_at: summary.merged_at,
          tables_affected: summary.tables_merged
            .filter(t => t.rows_moved > 0 || t.rows_skipped_duplicate > 0)
            .map(t => t.table_name),
        }),
      ]
    );

    await client.query('COMMIT');

    // =====================================================
    // 6. Delete secondary user from WorkOS (after commit)
    // =====================================================
    try {
      await workos.userManagement.deleteUser(secondaryUserId);
      summary.workos_user_deleted = true;
      logger.info({ secondaryUserId }, 'Deleted secondary user from WorkOS');
    } catch (workosError) {
      logger.error(
        { error: workosError, secondaryUserId },
        'Failed to delete secondary user from WorkOS - manual cleanup may be required'
      );
      summary.warnings.push(
        'Failed to delete secondary user from WorkOS. The user may need to be manually deleted in the WorkOS Dashboard.'
      );
    }

    logger.info(
      {
        primaryUserId,
        secondaryUserId,
        totalMoved: summary.tables_merged.reduce((sum, t) => sum + t.rows_moved, 0),
        workosDeleted: summary.workos_user_deleted,
      },
      'User merge completed successfully'
    );

    return summary;
  } catch (error) {
    await client.query('ROLLBACK');

    logger.error(
      { error, primaryUserId, secondaryUserId },
      'User merge failed, rolled back'
    );

    throw error;
  } finally {
    client.release();
  }
}
