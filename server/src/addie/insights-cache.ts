/**
 * In-memory caches for Addie data
 *
 * Caches:
 * 1. Member insights - per user, 30-min TTL, invalidated on writes
 * 2. Active goals - global (mapped/unmapped variants), 30-min TTL, invalidated on goal changes
 */

import { InsightsDatabase, type MemberInsight, type InsightGoal } from '../db/insights-db.js';
import { logger } from '../logger.js';

// =====================================================
// MEMBER INSIGHTS CACHE
// =====================================================

const INSIGHTS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_INSIGHTS_CACHE_SIZE = 1000;

interface InsightsCacheEntry {
  insights: MemberInsight[];
  expiresAt: number;
}

const insightsCache = new Map<string, InsightsCacheEntry>();

// =====================================================
// ACTIVE GOALS CACHE
// =====================================================

const GOALS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (invalidated on goal changes)

interface GoalsCacheEntry {
  goals: InsightGoal[];
  expiresAt: number;
}

// Only 2 possible keys: 'mapped' and 'unmapped'
const goalsCache = new Map<string, GoalsCacheEntry>();

const insightsDb = new InsightsDatabase();

/**
 * Get member insights with caching
 *
 * @param slackUserId - Slack user ID
 * @returns Array of member insights (empty array if none found or on error)
 */
export async function getCachedInsights(slackUserId: string): Promise<MemberInsight[]> {
  const now = Date.now();

  // Check cache
  const cached = insightsCache.get(slackUserId);
  if (cached && cached.expiresAt > now) {
    return cached.insights;
  }

  // Fetch from database
  try {
    const insights = await insightsDb.getInsightsForUser(slackUserId);

    // Evict oldest entries if cache is full
    if (insightsCache.size >= MAX_INSIGHTS_CACHE_SIZE) {
      const oldestKey = insightsCache.keys().next().value;
      if (oldestKey) {
        insightsCache.delete(oldestKey);
      }
    }

    // Cache the result
    insightsCache.set(slackUserId, {
      insights,
      expiresAt: now + INSIGHTS_CACHE_TTL_MS,
    });

    return insights;
  } catch (err) {
    logger.warn({ error: err, slackUserId }, 'Insights cache: Failed to fetch insights');
    return [];
  }
}

/**
 * Prefetch insights for a user (non-blocking)
 * Call this when a user starts interacting to warm the cache
 */
export function prefetchInsights(slackUserId: string): void {
  // Only prefetch if not already cached
  const cached = insightsCache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return;
  }

  // Fire and forget - don't await
  getCachedInsights(slackUserId).catch(() => {
    // Error already logged in getCachedInsights
  });
}

/**
 * Invalidate insights cache for a user (call after extracting new insights)
 */
export function invalidateInsightsCache(slackUserId: string): void {
  insightsCache.delete(slackUserId);
}

/**
 * Clear entire insights cache (for testing or admin purposes)
 */
export function clearInsightsCache(): void {
  insightsCache.clear();
}

// =====================================================
// ACTIVE GOALS CACHE FUNCTIONS
// =====================================================

/**
 * Get active goals with caching
 *
 * @param isMapped - Whether the user is mapped (has linked account)
 * @returns Array of active insight goals
 */
export async function getCachedActiveGoals(isMapped: boolean): Promise<InsightGoal[]> {
  const now = Date.now();
  const cacheKey = isMapped ? 'mapped' : 'unmapped';

  // Check cache
  const cached = goalsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.goals;
  }

  // Fetch from database
  try {
    const goals = await insightsDb.getActiveGoalsForUser(isMapped);

    // Cache the result
    goalsCache.set(cacheKey, {
      goals,
      expiresAt: now + GOALS_CACHE_TTL_MS,
    });

    return goals;
  } catch (err) {
    logger.warn({ error: err, isMapped }, 'Goals cache: Failed to fetch active goals');
    return [];
  }
}

/**
 * Invalidate goals cache (call when goals are created/updated/deleted)
 */
export function invalidateGoalsCache(): void {
  goalsCache.clear();
}
