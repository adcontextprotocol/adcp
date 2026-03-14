/**
 * In-memory session state for the training agent.
 *
 * Sessions are keyed by account identifier (open mode) or userId+moduleId
 * (training mode). State is ephemeral — cleared on server restart.
 * TTL-based cleanup runs every 5 minutes.
 */

import type { SessionState } from './types.js';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 1000;
const MAX_MEDIA_BUYS_PER_SESSION = 100;
const MAX_CREATIVES_PER_SESSION = 500;

const sessions = new Map<string, SessionState>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function createSession(): SessionState {
  const now = new Date();
  return {
    mediaBuys: new Map(),
    creatives: new Map(),
    signalActivations: new Map(),
    createdAt: now,
    lastAccessedAt: now,
  };
}

/**
 * Get or create a session for the given key.
 * Updates lastAccessedAt on every access.
 */
export function getSession(key: string): SessionState {
  let session = sessions.get(key);
  if (!session) {
    // Evict oldest session if at capacity
    if (sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, s] of sessions) {
        if (s.lastAccessedAt.getTime() < oldestTime) {
          oldestTime = s.lastAccessedAt.getTime();
          oldestKey = k;
        }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    session = createSession();
    sessions.set(key, session);
  }
  session.lastAccessedAt = new Date();
  return session;
}

export { MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION };

/**
 * Derive a session key from the request context.
 *
 * Open mode: keyed by account brand domain. This is intentionally shared —
 * callers using the same brand.domain see the same session state, which
 * mirrors how a real publisher scopes state per advertiser account.
 * The bearer token is shared across all sandbox callers.
 *
 * Training mode: keyed by userId + moduleId for per-learner isolation.
 */
export function sessionKeyFromArgs(
  args: Record<string, unknown>,
  mode: 'open' | 'training',
  userId?: string,
  moduleId?: string,
): string {
  if (mode === 'training' && userId) {
    return `training:${userId}:${moduleId || 'default'}`;
  }
  const account = args.account as Record<string, unknown> | undefined;
  const brand = account?.brand as Record<string, unknown> | undefined;
  const domain = brand?.domain as string | undefined;
  return `open:${domain || 'default'}`;
}

/** Start the TTL cleanup interval */
export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastAccessedAt.getTime() > SESSION_TTL_MS) {
        sessions.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't block process exit
  if (cleanupTimer.unref) cleanupTimer.unref();
}

/** Stop the cleanup interval (for tests) */
export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Clear all sessions (for tests) */
export function clearSessions(): void {
  sessions.clear();
}
