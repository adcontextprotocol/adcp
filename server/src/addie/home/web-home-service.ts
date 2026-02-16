/**
 * Web Addie Home Service
 *
 * Generates home content for web users (authenticated via WorkOS).
 * Uses getWebMemberContext instead of Slack-based getMemberContext.
 */

import type { HomeContent, GreetingSection } from './types.js';
import { getWebMemberContext, type MemberContext } from '../member-context.js';
import { isWebUserAAOAdmin } from '../mcp/admin-tools.js';
import { buildAlerts } from './builders/alerts.js';
import { buildQuickActions } from './builders/quick-actions.js';
import { buildActivityFeed } from './builders/activity.js';
import { buildStats } from './builders/stats.js';
import { buildAdminPanel } from './builders/admin.js';
import { logger } from '../../logger.js';

/**
 * Get home content for a web user (WorkOS user ID)
 */
export async function getWebHomeContent(workosUserId: string): Promise<HomeContent> {
  logger.debug({ workosUserId }, 'Addie Web Home: Building content');

  // Get member context for web user
  const memberContext = await getWebMemberContext(workosUserId);

  // Check if user is AAO admin (based on aao-admin working group membership)
  const userIsAdmin = await isWebUserAAOAdmin(workosUserId);

  // Get admin user ID for prospect stats (if admin)
  const adminUserId = userIsAdmin ? workosUserId : undefined;

  // Build all sections in parallel for speed
  const [alerts, activity, adminPanel] = await Promise.all([
    buildAlerts(memberContext),
    buildActivityFeed(memberContext),
    userIsAdmin ? buildAdminPanel(adminUserId) : Promise.resolve(null),
  ]);

  // Build synchronous sections
  const greeting = buildGreeting(memberContext);
  const quickActions = buildQuickActions(memberContext, userIsAdmin);
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

  logger.info(
    {
      workosUserId,
      isMember: memberContext.is_member,
      isAdmin: userIsAdmin,
      alertCount: alerts.length,
      activityCount: activity.length,
    },
    'Addie Web Home: Content built successfully'
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
  }

  return {
    userName,
    orgName: memberContext.organization?.name ?? null,
    isMember: memberContext.is_member,
    isLinked: memberContext.slack_linked,
  };
}
