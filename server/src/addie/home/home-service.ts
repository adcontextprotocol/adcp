/**
 * Addie Home Service
 *
 * Orchestrates home content generation from various data sources.
 * Platform-agnostic - produces HomeContent that renderers convert to Block Kit, HTML, etc.
 */

import type { HomeContent, GreetingSection } from './types.js';
import { getHomeContentCache } from './cache.js';
import { getMemberContext, type MemberContext } from '../member-context.js';
import { isSlackUserAdmin } from '../mcp/admin-tools.js';
import { buildAlerts } from './builders/alerts.js';
import { buildQuickActions } from './builders/quick-actions.js';
import { buildActivityFeed } from './builders/activity.js';
import { buildStats } from './builders/stats.js';
import { buildAdminPanel } from './builders/admin.js';
import { logger } from '../../logger.js';

export interface GetHomeContentOptions {
  /** Bypass cache and fetch fresh data */
  forceRefresh?: boolean;
}

/**
 * Get home content for a Slack user
 */
export async function getHomeContent(
  slackUserId: string,
  options: GetHomeContentOptions = {}
): Promise<HomeContent> {
  const cache = getHomeContentCache();

  // Check cache unless force refresh requested
  if (!options.forceRefresh) {
    const cached = cache.get(slackUserId);
    if (cached) {
      logger.debug({ slackUserId }, 'Addie Home: Using cached content');
      return cached;
    }
  }

  logger.debug({ slackUserId }, 'Addie Home: Building fresh content');

  // Get member context (has its own 30-min cache)
  const memberContext = await getMemberContext(slackUserId);

  // Check if user is admin
  const isAdmin = await isSlackUserAdmin(slackUserId);

  // Build all sections in parallel for speed
  const [alerts, activity, adminPanel] = await Promise.all([
    buildAlerts(memberContext),
    buildActivityFeed(memberContext),
    isAdmin ? buildAdminPanel() : Promise.resolve(null),
  ]);

  // Build synchronous sections
  const greeting = buildGreeting(memberContext);
  const quickActions = buildQuickActions(memberContext, isAdmin);
  const stats = buildStats(memberContext);

  const content: HomeContent = {
    greeting,
    alerts,
    quickActions,
    activity,
    stats,
    adminPanel,
    lastUpdated: new Date(),
  };

  // Cache the result
  cache.set(slackUserId, content);

  logger.info(
    {
      slackUserId,
      isMember: memberContext.is_member,
      isAdmin,
      alertCount: alerts.length,
      activityCount: activity.length,
    },
    'Addie Home: Content built successfully'
  );

  return content;
}

/**
 * Build greeting section from member context
 */
function buildGreeting(memberContext: MemberContext): GreetingSection {
  // Determine user's display name
  let userName = 'there';
  if (memberContext.workos_user?.first_name) {
    userName = memberContext.workos_user.first_name;
  } else if (memberContext.slack_user?.display_name) {
    userName = memberContext.slack_user.display_name;
  }

  return {
    userName,
    orgName: memberContext.organization?.name ?? null,
    isMember: memberContext.is_member,
    isLinked: memberContext.slack_linked,
  };
}
