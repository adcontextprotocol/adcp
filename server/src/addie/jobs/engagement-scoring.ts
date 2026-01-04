/**
 * Engagement Scoring Job
 *
 * Periodically updates engagement and excitement scores for users and organizations.
 * Scores are computed from activity data (Slack, email, conversations, community).
 *
 * User scoring (0-100):
 * - Slack activity: up to 30 points
 * - Email engagement: up to 20 points
 * - Addie conversations: up to 25 points
 * - Community participation: up to 25 points
 *
 * Organization scoring (0-100):
 * - Slack users: up to 20 points
 * - Team members: up to 15 points
 * - Working groups: up to 15 points
 * - Recent activity: up to 15 points
 * - Email engagement: up to 15 points
 * - Event interest: up to 10 points
 * - Interest level: up to 10 points
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';

export interface EngagementScoringResult {
  usersUpdated: number;
  orgsUpdated: number;
}

/**
 * Run the engagement scoring job
 * Updates stale scores (older than 1 day) for users and organizations
 */
export async function runEngagementScoringJob(options: {
  usersPerBatch?: number;
  orgsPerBatch?: number;
} = {}): Promise<EngagementScoringResult> {
  const { usersPerBatch = 100, orgsPerBatch = 100 } = options;

  logger.info({ usersPerBatch, orgsPerBatch }, 'Running engagement scoring job');

  // Update stale user scores
  const userResult = await query<{ update_stale_user_scores: number }>(
    `SELECT update_stale_user_scores($1) as update_stale_user_scores`,
    [usersPerBatch]
  );
  const usersUpdated = userResult.rows[0]?.update_stale_user_scores || 0;

  // Update stale org scores
  const orgResult = await query<{ update_stale_org_engagement_scores: number }>(
    `SELECT update_stale_org_engagement_scores($1) as update_stale_org_engagement_scores`,
    [orgsPerBatch]
  );
  const orgsUpdated = orgResult.rows[0]?.update_stale_org_engagement_scores || 0;

  logger.info({ usersUpdated, orgsUpdated }, 'Engagement scoring job completed');

  return { usersUpdated, orgsUpdated };
}

/**
 * Force update scores for a specific user
 */
export async function updateUserScores(workosUserId: string): Promise<void> {
  await query(`SELECT update_user_scores($1)`, [workosUserId]);
  logger.debug({ workosUserId }, 'Updated user scores');
}

/**
 * Force update scores for a specific organization
 */
export async function updateOrgScores(workosOrgId: string): Promise<void> {
  await query(`SELECT update_org_engagement($1)`, [workosOrgId]);
  logger.debug({ workosOrgId }, 'Updated org scores');
}
