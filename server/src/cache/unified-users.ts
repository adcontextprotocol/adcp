/**
 * Unified users cache
 *
 * Caches WorkOS users by organization to avoid repeated API calls.
 * Used by admin endpoints that need to display user information.
 */

export interface WorkOSUserInfo {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface UnifiedUsersCache {
  usersByOrg: Map<string, WorkOSUserInfo[]>;
  expiresAt: number;
}

let unifiedUsersCache: UnifiedUsersCache | null = null;
const UNIFIED_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - invalidated on mutations

export function getUnifiedUsersCache(): Map<string, WorkOSUserInfo[]> | null {
  if (unifiedUsersCache && unifiedUsersCache.expiresAt > Date.now()) {
    return unifiedUsersCache.usersByOrg;
  }
  unifiedUsersCache = null;
  return null;
}

export function setUnifiedUsersCache(usersByOrg: Map<string, WorkOSUserInfo[]>): void {
  unifiedUsersCache = {
    usersByOrg,
    expiresAt: Date.now() + UNIFIED_CACHE_TTL_MS,
  };
}

export function invalidateUnifiedUsersCache(): void {
  unifiedUsersCache = null;
}
