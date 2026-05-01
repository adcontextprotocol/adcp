/**
 * Member-context cache primitives.
 *
 * Extracted from `member-context.ts` so callers that only need to invalidate
 * the cache (route handlers, the membership service) don't have to pull in
 * `middleware/auth.ts` and its WorkOS module-load side effects. Keeps the
 * unit-test import graph clean.
 *
 * The cache itself stores the resolved MemberContext keyed on slack user id,
 * with a 30-minute TTL — context data is rarely-changing, and we invalidate
 * explicitly on specific events (membership changes, profile updates, etc.).
 */

import type { MemberContext } from './member-context.js';

const MEMBER_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedEntry {
  context: MemberContext;
  timestamp: number;
}

const memberContextCache = new Map<string, CachedEntry>();

export function getCachedMemberContext(slackUserId: string): MemberContext | null {
  const cached = memberContextCache.get(slackUserId);
  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > MEMBER_CONTEXT_CACHE_TTL_MS) {
    memberContextCache.delete(slackUserId);
    return null;
  }

  return cached.context;
}

export function setCachedMemberContext(slackUserId: string, context: MemberContext): void {
  memberContextCache.set(slackUserId, { context, timestamp: Date.now() });
}

/**
 * Invalidate cached context for a user. Call after membership changes,
 * profile updates, or anywhere else the cached value would be stale.
 * No-op when the user isn't cached.
 *
 * Pass no argument to clear the entire cache (used by tools that change
 * data spanning multiple users — e.g. a working-group leader change
 * affects every member of that WG).
 */
export function invalidateMemberContextCache(slackUserId?: string): void {
  if (slackUserId) {
    memberContextCache.delete(slackUserId);
  } else {
    memberContextCache.clear();
  }
}
