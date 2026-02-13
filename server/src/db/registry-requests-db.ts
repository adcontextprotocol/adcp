import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('registry-requests-db');

type EntityType = 'brand' | 'property';
const MAX_DOMAIN_LENGTH = 253;

export interface RegistryRequest {
  entity_type: EntityType;
  domain: string;
  first_requested_at: Date;
  last_requested_at: Date;
  request_count: number;
  resolved_at: Date | null;
  resolved_to_domain: string | null;
}

export interface RegistryRequestStats {
  total_unresolved: number;
  total_resolved: number;
  top_requested: Array<{
    domain: string;
    request_count: number;
    last_requested_at: Date;
  }>;
}

export class RegistryRequestsDatabase {
  async trackRequest(entityType: EntityType, domain: string): Promise<void> {
    const normalized = domain.toLowerCase();
    if (normalized.length > MAX_DOMAIN_LENGTH) return;

    await query(
      `INSERT INTO registry_requests (entity_type, domain)
       VALUES ($1, $2)
       ON CONFLICT (entity_type, domain) DO UPDATE SET
         request_count = registry_requests.request_count + 1,
         last_requested_at = NOW()`,
      [entityType, normalized]
    );
  }

  async markResolved(entityType: EntityType, domain: string, resolvedToDomain: string): Promise<boolean> {
    const result = await query(
      `UPDATE registry_requests
       SET resolved_at = NOW(), resolved_to_domain = $3
       WHERE entity_type = $1 AND domain = $2 AND resolved_at IS NULL`,
      [entityType, domain.toLowerCase(), resolvedToDomain.toLowerCase()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listUnresolved(
    entityType: EntityType,
    options: { limit?: number; offset?: number } = {}
  ): Promise<RegistryRequest[]> {
    const limit = Math.min(options.limit || 50, 200);
    const offset = options.offset || 0;

    const result = await query<RegistryRequest>(
      `SELECT * FROM registry_requests
       WHERE entity_type = $1 AND resolved_at IS NULL
       ORDER BY request_count DESC, last_requested_at DESC
       LIMIT $2 OFFSET $3`,
      [entityType, limit, offset]
    );
    return result.rows;
  }

  async getStats(entityType: EntityType, topN: number = 10): Promise<RegistryRequestStats> {
    topN = Math.min(Math.max(1, topN), 100);
    const [unresolvedResult, resolvedResult, topResult] = await Promise.all([
      query<{ count: string }>(
        'SELECT COUNT(*) as count FROM registry_requests WHERE entity_type = $1 AND resolved_at IS NULL',
        [entityType]
      ),
      query<{ count: string }>(
        'SELECT COUNT(*) as count FROM registry_requests WHERE entity_type = $1 AND resolved_at IS NOT NULL',
        [entityType]
      ),
      query<{ domain: string; request_count: number; last_requested_at: Date }>(
        `SELECT domain, request_count, last_requested_at
         FROM registry_requests
         WHERE entity_type = $1 AND resolved_at IS NULL
         ORDER BY request_count DESC
         LIMIT $2`,
        [entityType, topN]
      ),
    ]);

    return {
      total_unresolved: parseInt(unresolvedResult.rows[0].count, 10),
      total_resolved: parseInt(resolvedResult.rows[0].count, 10),
      top_requested: topResult.rows,
    };
  }
}

export const registryRequestsDb = new RegistryRequestsDatabase();
