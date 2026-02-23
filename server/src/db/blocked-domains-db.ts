import { query } from './client.js';

export interface BlockedDomain {
  id: string;
  domain: string;
  domain_type: 'ad_server' | 'intermediary' | 'cdn' | 'tracker';
  reason: string | null;
  added_by: string;
  created_at: Date;
}

export class BlockedDomainsDatabase {
  /**
   * Check which domains in the given list are blocked.
   * Returns a map of domain → blocked entry for matched domains only.
   */
  async checkDomains(domains: string[]): Promise<Map<string, BlockedDomain>> {
    if (domains.length === 0) return new Map();

    const result = await query<BlockedDomain>(
      `SELECT * FROM blocked_domains WHERE domain = ANY($1)`,
      [domains]
    );

    const map = new Map<string, BlockedDomain>();
    for (const row of result.rows) {
      map.set(row.domain, row);
    }
    return map;
  }

  async getAll(): Promise<BlockedDomain[]> {
    const result = await query<BlockedDomain>(
      `SELECT * FROM blocked_domains ORDER BY domain_type, domain`
    );
    return result.rows;
  }

  async add(input: {
    domain: string;
    domain_type: 'ad_server' | 'intermediary' | 'cdn' | 'tracker';
    reason?: string;
    added_by?: string;
  }): Promise<BlockedDomain> {
    const result = await query<BlockedDomain>(
      `INSERT INTO blocked_domains (domain, domain_type, reason, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain) DO UPDATE SET
         domain_type = EXCLUDED.domain_type,
         reason = EXCLUDED.reason,
         added_by = EXCLUDED.added_by
       RETURNING *`,
      [input.domain, input.domain_type, input.reason ?? null, input.added_by ?? 'system']
    );
    return result.rows[0];
  }
}
