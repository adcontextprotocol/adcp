/**
 * Configuration Versioning for Addie
 *
 * Tracks versions of Addie's configuration (rules + router) so we can:
 * - Log a simple version_id with each message instead of full config
 * - Analyze feedback by configuration version
 * - Compare performance across config changes
 *
 * Each unique combination of active rules + router config gets a version ID.
 * When config changes, a new version is created; when it reverts, existing version is reused.
 */

import { createHash } from 'crypto';
import { query } from '../db/client.js';
import { logger } from '../logger.js';
import { ROUTING_RULES } from './router.js';

// Types
export interface ConfigVersion {
  version_id: number;
  config_hash: string;
  active_rule_ids: number[];
  rules_snapshot: unknown;
  router_rules_hash: string | null;
  created_at: Date;
  message_count: number;
  positive_feedback: number;
  negative_feedback: number;
  avg_rating: number | null;
}

export interface RuleSnapshot {
  id: number;
  rule_type: string;
  name: string;
  content: string;
  priority: number;
}

// Cache for current config version (revalidated periodically)
let cachedVersion: ConfigVersion | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Compute hash of the ROUTING_RULES constant
 * This captures the router configuration that's defined in code
 */
export function computeRouterRulesHash(): string {
  const routerJson = JSON.stringify(ROUTING_RULES);
  return createHash('sha256').update(routerJson).digest('hex').substring(0, 16);
}

/**
 * Compute config hash from rule IDs and router rules
 */
function computeConfigHash(ruleIds: number[], routerHash: string): string {
  const sortedIds = [...ruleIds].sort((a, b) => a - b);
  const input = `rules:${sortedIds.join(',')}|router:${routerHash}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 32);
}

/**
 * Get or create a config version for the given rules
 *
 * @param ruleIds - Active rule IDs
 * @param rulesSnapshot - Full rule content (for logging/debugging)
 * @returns The config version record
 */
export async function getOrCreateConfigVersion(
  ruleIds: number[],
  rulesSnapshot: RuleSnapshot[]
): Promise<ConfigVersion> {
  const routerHash = computeRouterRulesHash();
  const configHash = computeConfigHash(ruleIds, routerHash);

  // Check cache first
  const now = Date.now();
  if (cachedVersion && cachedVersion.config_hash === configHash && now < cacheExpiry) {
    return cachedVersion;
  }

  try {
    // Try to find existing version with this hash
    const existing = await query<ConfigVersion>(
      `SELECT * FROM addie_config_versions WHERE config_hash = $1`,
      [configHash]
    );

    if (existing.rows.length > 0) {
      cachedVersion = existing.rows[0];
      cacheExpiry = now + CACHE_TTL_MS;
      return cachedVersion;
    }

    // Create new version
    const result = await query<ConfigVersion>(
      `INSERT INTO addie_config_versions (
        config_hash, active_rule_ids, rules_snapshot, router_rules_hash
      ) VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [
        configHash,
        ruleIds,
        JSON.stringify(rulesSnapshot),
        routerHash,
      ]
    );

    cachedVersion = result.rows[0];
    cacheExpiry = now + CACHE_TTL_MS;

    logger.info({
      version_id: cachedVersion.version_id,
      config_hash: configHash,
      rule_count: ruleIds.length,
    }, 'Config: Created new configuration version');

    return cachedVersion;
  } catch (error) {
    logger.error({ error }, 'Config: Failed to get/create config version');
    throw error;
  }
}

/**
 * Get current config version ID (for logging with messages)
 * Returns null if config versioning isn't available (e.g., database not ready)
 */
export async function getCurrentConfigVersionId(
  ruleIds: number[],
  rulesSnapshot: RuleSnapshot[]
): Promise<number | null> {
  try {
    const version = await getOrCreateConfigVersion(ruleIds, rulesSnapshot);
    return version.version_id;
  } catch {
    // Don't fail message processing if config versioning fails
    return null;
  }
}

/**
 * Get config version by ID
 */
export async function getConfigVersion(versionId: number): Promise<ConfigVersion | null> {
  const result = await query<ConfigVersion>(
    `SELECT * FROM addie_config_versions WHERE version_id = $1`,
    [versionId]
  );
  return result.rows[0] || null;
}

/**
 * Get config version comparison - useful for seeing what changed between versions
 */
export async function compareConfigVersions(
  versionIdA: number,
  versionIdB: number
): Promise<{
  added_rules: number[];
  removed_rules: number[];
  router_changed: boolean;
  version_a: ConfigVersion | null;
  version_b: ConfigVersion | null;
}> {
  const [versionA, versionB] = await Promise.all([
    getConfigVersion(versionIdA),
    getConfigVersion(versionIdB),
  ]);

  if (!versionA || !versionB) {
    return {
      added_rules: [],
      removed_rules: [],
      router_changed: false,
      version_a: versionA,
      version_b: versionB,
    };
  }

  const rulesA = new Set(versionA.active_rule_ids);
  const rulesB = new Set(versionB.active_rule_ids);

  const added_rules = versionB.active_rule_ids.filter(id => !rulesA.has(id));
  const removed_rules = versionA.active_rule_ids.filter(id => !rulesB.has(id));
  const router_changed = versionA.router_rules_hash !== versionB.router_rules_hash;

  return {
    added_rules,
    removed_rules,
    router_changed,
    version_a: versionA,
    version_b: versionB,
  };
}

/**
 * Get recent config versions with their performance metrics
 */
export async function getRecentConfigVersions(limit = 10): Promise<ConfigVersion[]> {
  const result = await query<ConfigVersion>(
    `SELECT * FROM addie_config_versions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Invalidate the cached config version (call when rules change)
 */
export function invalidateConfigCache(): void {
  cachedVersion = null;
  cacheExpiry = 0;
}
