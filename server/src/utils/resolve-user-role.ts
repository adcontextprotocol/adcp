import { createLogger } from '../logger.js';

const logger = createLogger('resolve-user-role');

// Role priority for resolving the effective role from multiple memberships.
// Higher index = higher privilege. When a user has multiple memberships for the
// same org (e.g. an active 'owner' and a pending invitation as 'member'),
// we pick the highest-privilege active one.
const ROLE_PRIORITY: Record<string, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Resolve the effective role for a user from a list of WorkOS organization memberships.
 * Filters to active memberships and returns the highest-privilege role slug found,
 * or null if no active memberships exist.
 */
export function resolveUserRole(memberships: { status: string; role?: { slug: string } }[]): string | null {
  let best = -1;
  let bestSlug: string | null = null;
  for (const m of memberships) {
    if (m.status !== 'active') continue;
    const slug = m.role?.slug || 'member';
    const priority = ROLE_PRIORITY[slug];
    if (priority === undefined) {
      logger.warn({ slug }, 'Unknown organization role slug encountered');
      continue;
    }
    if (priority > best) {
      best = priority;
      bestSlug = slug;
    }
  }
  return bestSlug;
}
