/**
 * Admin Panel Builder
 *
 * Builds admin-only panel with flagged threads and outreach goal stats.
 */

import type { AdminPanel, GoalProgress } from '../types.js';
import { AddieDatabase } from '../../../db/addie-db.js';
import { getPool } from '../../../db/client.js';
import { logger } from '../../../logger.js';

const addieDb = new AddieDatabase();

/**
 * Build admin panel with flagged threads, goal progress, and prospect stats
 * @param adminUserId - WorkOS user ID for prospect ownership lookup
 */
export async function buildAdminPanel(adminUserId?: string): Promise<AdminPanel> {
  let flaggedThreadCount = 0;
  const insightGoals: GoalProgress[] = [];
  let prospectStats: AdminPanel['prospectStats'] = undefined;

  // Get flagged thread count from interaction stats
  try {
    const stats = await addieDb.getInteractionStats({ days: 30 });
    flaggedThreadCount = stats.flagged;
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch flagged threads count for admin panel');
  }

  // Get outreach goal stats from the planner's tracking
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT
        og.name,
        COUNT(ugh.id) FILTER (WHERE ugh.status = 'success') as success_count,
        COUNT(ugh.id) as attempt_count
      FROM outreach_goals og
      LEFT JOIN user_goal_history ugh ON ugh.goal_id = og.id
      WHERE og.is_enabled = TRUE
      GROUP BY og.id, og.name
      ORDER BY og.base_priority DESC
      LIMIT 5
    `);
    for (const row of result.rows) {
      insightGoals.push({
        goalName: row.name,
        current: parseInt(row.success_count) || 0,
        target: null, // No fixed target - show success count
      });
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch outreach goals for admin panel');
  }

  // Get prospect stats if we have a user ID
  if (adminUserId) {
    try {
      const pool = getPool();
      const result = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN o.engagement_score >= 30 THEN 1 END) as hot,
          COUNT(CASE
            WHEN EXISTS (
              SELECT 1 FROM org_activities
              WHERE organization_id = o.workos_organization_id
                AND is_next_step = TRUE
                AND next_step_completed_at IS NULL
                AND next_step_due_date < CURRENT_DATE
            )
              OR EXTRACT(DAY FROM NOW() - COALESCE(
                (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id),
                o.created_at
              )) >= 14
            THEN 1
          END) as needs_followup
        FROM organizations o
        JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
        WHERE os.user_id = $1
          AND os.role = 'owner'
          AND o.is_personal IS NOT TRUE
          AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
      `, [adminUserId]);

      const row = result.rows[0];
      if (row && parseInt(row.total) > 0) {
        prospectStats = {
          totalOwned: parseInt(row.total) || 0,
          hotCount: parseInt(row.hot) || 0,
          needsFollowupCount: parseInt(row.needs_followup) || 0,
        };
      }
    } catch (error) {
      logger.warn({ error, adminUserId }, 'Failed to fetch prospect stats for admin panel');
    }
  }

  return {
    flaggedThreadCount,
    insightGoals,
    prospectStats,
  };
}
