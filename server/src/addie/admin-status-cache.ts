/**
 * Admin-status cache primitives for both Slack and web admin lookups.
 *
 * Extracted from `mcp/admin-tools.ts` so callers that only need to
 * invalidate (route handlers, services, account/membership flows) don't
 * have to pull in the entire admin-tools module — which transitively
 * loads relationship-orchestrator, engagement-planner, and instantiates
 * Anthropic at module load. Keeps the unit-test import graph small and
 * stops admin-tools from being a chokepoint that pulls Anthropic into
 * unrelated dependency chains.
 *
 * The cache values themselves stay private here — only invalidation is
 * exported. Read paths still live in admin-tools.ts where they belong.
 */

const slackAdminStatusCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();
const webAdminStatusCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

export function getSlackAdminStatusCache(): Map<string, { isAdmin: boolean; expiresAt: number }> {
  return slackAdminStatusCache;
}

export function getWebAdminStatusCache(): Map<string, { isAdmin: boolean; expiresAt: number }> {
  return webAdminStatusCache;
}

/**
 * Invalidate Slack admin status cache. Pass no argument to clear the
 * entire cache (used when admin assignments change for an unknown set of
 * users).
 */
export function invalidateSlackAdminStatusCache(slackUserId?: string): void {
  if (slackUserId) {
    slackAdminStatusCache.delete(slackUserId);
  } else {
    slackAdminStatusCache.clear();
  }
}

/**
 * Invalidate web (WorkOS) admin status cache. Pass no argument to clear
 * the entire cache.
 */
export function invalidateWebAdminStatusCache(workosUserId?: string): void {
  if (workosUserId) {
    webAdminStatusCache.delete(workosUserId);
  } else {
    webAdminStatusCache.clear();
  }
}

/**
 * Clear both caches. Used when an admin role change invalidates Slack
 * and web entries simultaneously.
 */
export function invalidateAllAdminStatusCaches(): void {
  slackAdminStatusCache.clear();
  webAdminStatusCache.clear();
}
