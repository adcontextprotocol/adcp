/**
 * In-memory session state for the training agent.
 *
 * Sessions are keyed by account identifier (open mode) or userId+moduleId
 * (training mode). State is ephemeral — cleared on server restart.
 * TTL-based cleanup runs every 5 minutes.
 */

import type { SessionState, AccountRef, BrandRef, UsageRecord } from './types.js';
import { cleanupExpiredTasks } from '@adcp/client';
import { isDatabaseInitialized, getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-state');

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 1000;
const MAX_MEDIA_BUYS_PER_SESSION = 100;
const MAX_CREATIVES_PER_SESSION = 500;
const MAX_PROPERTY_LISTS_PER_SESSION = 100;
const MAX_CONTENT_STANDARDS_PER_SESSION = 100;

const sessions = new Map<string, SessionState>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function createSession(): SessionState {
  const now = new Date();
  return {
    mediaBuys: new Map(),
    governancePlans: new Map(),
    governanceChecks: new Map(),
    governanceOutcomes: new Map(),
    propertyLists: new Map(),
    contentStandards: new Map(),
    creatives: new Map(),
    signalActivations: new Map(),
    usageRecords: [],
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

const MAX_USAGE_RECORDS_PER_SESSION = 1000;

export { MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION, MAX_USAGE_RECORDS_PER_SESSION, MAX_PROPERTY_LISTS_PER_SESSION, MAX_CONTENT_STANDARDS_PER_SESSION };

/** Read-only access to all sessions (for cross-session lookups). */
export function getAllSessions(): ReadonlyMap<string, SessionState> {
  return sessions;
}

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
  args: { account?: AccountRef; brand?: BrandRef },
  mode: 'open' | 'training',
  userId?: string,
  moduleId?: string,
): string {
  if (mode === 'training' && userId) {
    return `training:${userId}:${moduleId || 'default'}`;
  }
  const account = args.account;
  // account-ref is either {account_id} or {brand: {domain}, operator}
  if (account?.account_id) return `open:${account.account_id}`;
  const domain = account?.brand?.domain ?? args.brand?.domain;
  return `open:${domain || 'default'}`;
}

/** Start the TTL cleanup interval */
export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastAccessedAt.getTime() > SESSION_TTL_MS) {
        sessions.delete(key);
      }
    }
    // Clean up expired MCP tasks from PostgreSQL
    try {
      if (isDatabaseInitialized()) {
        const deleted = await cleanupExpiredTasks(getPool());
        if (deleted > 0) {
          logger.info({ deleted }, 'Cleaned up expired MCP tasks');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up expired MCP tasks');
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
