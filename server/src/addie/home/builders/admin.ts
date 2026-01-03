/**
 * Admin Panel Builder
 *
 * Builds admin-only panel with flagged threads and insight goals.
 */

import type { AdminPanel, GoalProgress } from '../types.js';
import { AddieDatabase } from '../../../db/addie-db.js';
import { InsightsDatabase } from '../../../db/insights-db.js';
import { logger } from '../../../logger.js';

const addieDb = new AddieDatabase();
const insightsDb = new InsightsDatabase();

/**
 * Build admin panel with flagged threads and goal progress
 */
export async function buildAdminPanel(): Promise<AdminPanel> {
  let flaggedThreadCount = 0;
  const insightGoals: GoalProgress[] = [];

  // Get flagged thread count from interaction stats
  try {
    const stats = await addieDb.getInteractionStats({ days: 30 });
    flaggedThreadCount = stats.flagged;
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch flagged threads count for admin panel');
  }

  // Get active insight goals with progress
  try {
    const activeGoals = await insightsDb.listGoals({ activeOnly: true });
    for (const goal of activeGoals.slice(0, 5)) {
      insightGoals.push({
        goalName: goal.name,
        current: goal.current_response_count,
        target: goal.target_response_count,
      });
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch insight goals for admin panel');
  }

  return {
    flaggedThreadCount,
    insightGoals,
  };
}
