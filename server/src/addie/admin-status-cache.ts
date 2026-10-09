/**
 * Compatibility invalidators for former AAO-admin authorization caches.
 *
 * Extracted from `mcp/admin-tools.ts` so callers that only need to
 * invalidate (route handlers, services, account/membership flows) don't
 * have to pull in the entire admin-tools module — which transitively
 * loads relationship-orchestrator, engagement-planner, and instantiates
 * Anthropic at module load. Keeps the unit-test import graph small and
 * stops admin-tools from being a chokepoint that pulls Anthropic into
 * unrelated dependency chains.
 *
 * AAO-admin authorization is deliberately uncached so grants and revocations
 * are visible on every replica immediately. These functions remain as no-ops
 * while their distributed callers migrate.
 */

/**
 * Former Slack cache invalidator retained for source compatibility.
 */
export function invalidateSlackAdminStatusCache(slackUserId?: string): void {
  void slackUserId;
}

/**
 * Former web cache invalidator retained for source compatibility.
 */
export function invalidateWebAdminStatusCache(workosUserId?: string): void {
  void workosUserId;
}

/**
 * Former aggregate invalidator retained for source compatibility.
 */
export function invalidateAllAdminStatusCaches(): void {
  // Compatibility no-op: AAO-admin authorization results are not cached.
}
