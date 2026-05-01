/**
 * Web admin-status lookup for AAO admins.
 *
 * Extracted from `mcp/admin-tools.ts` so callers that only need to
 * check `is the WorkOS user an admin?` can do so without dragging in
 * relationship-orchestrator → engagement-planner → Anthropic at module
 * load. Same motivation as `member-context-cache.ts` and
 * `admin-status-cache.ts` (PR #3741) — keep the test import graph
 * small and stop `admin-tools` from being a chokepoint that pulls
 * heavy services into unrelated chains.
 *
 * The function body is the same membership-against-`aao-admin` check
 * the original lived in admin-tools.ts; admin-tools.ts now re-exports
 * from here so existing callers keep working.
 */

import { createLogger } from '../logger.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { getWebAdminStatusCache } from './admin-status-cache.js';

const logger = createLogger('admin-status-lookup');

const AAO_ADMIN_WORKING_GROUP_SLUG = 'aao-admin';
const ADMIN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const wgDb = new WorkingGroupDatabase();

export async function isWebUserAAOAdmin(workosUserId: string): Promise<boolean> {
  const cache = getWebAdminStatusCache();
  const cached = cache.get(workosUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isAdmin;
  }

  try {
    const adminGroup = await wgDb.getWorkingGroupBySlug(AAO_ADMIN_WORKING_GROUP_SLUG);
    if (!adminGroup) {
      logger.warn('AAO Admin working group not found');
      // Cache the negative result for a shorter time so a missing
      // admin group doesn't pin everyone to non-admin for 30 minutes.
      cache.set(workosUserId, { isAdmin: false, expiresAt: Date.now() + 5 * 60 * 1000 });
      return false;
    }

    const isAdmin = await wgDb.isMember(adminGroup.id, workosUserId);
    cache.set(workosUserId, { isAdmin, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });
    logger.debug({ workosUserId, isAdmin }, 'Checked web user admin status');
    return isAdmin;
  } catch (error) {
    logger.error({ error, workosUserId }, 'Error checking if web user is admin');
    return false;
  }
}
