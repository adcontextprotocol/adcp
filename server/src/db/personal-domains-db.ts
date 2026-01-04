import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('personal-domains-db');

export interface PersonalDomain {
  domain: string;
  reason: string | null;
  created_at: Date;
  created_by: string | null;
}

/**
 * Add a domain to the personal domains list.
 * Personal domains are excluded from corporate domain health checks.
 */
export async function addPersonalDomain(data: {
  domain: string;
  reason?: string;
  created_by?: string;
}): Promise<PersonalDomain> {
  const pool = getPool();
  const normalizedDomain = data.domain.toLowerCase().trim().replace(/^www\./, '');

  // Validate domain format
  const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!domainRegex.test(normalizedDomain)) {
    throw new Error(`Invalid domain format: ${normalizedDomain}`);
  }

  const result = await pool.query(
    `INSERT INTO personal_domains (domain, reason, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (domain) DO UPDATE SET
       reason = COALESCE(EXCLUDED.reason, personal_domains.reason),
       created_by = COALESCE(EXCLUDED.created_by, personal_domains.created_by)
     RETURNING *`,
    [normalizedDomain, data.reason || null, data.created_by || null]
  );

  logger.info({ domain: normalizedDomain, reason: data.reason }, 'Added personal domain');
  return result.rows[0];
}

/**
 * Remove a domain from the personal domains list.
 */
export async function removePersonalDomain(domain: string): Promise<boolean> {
  const pool = getPool();
  const normalizedDomain = domain.toLowerCase().trim().replace(/^www\./, '');

  const result = await pool.query(
    'DELETE FROM personal_domains WHERE domain = $1 RETURNING domain',
    [normalizedDomain]
  );

  if (result.rows.length > 0) {
    logger.info({ domain: normalizedDomain }, 'Removed personal domain');
    return true;
  }
  return false;
}

/**
 * Check if a domain is marked as personal.
 */
export async function isPersonalDomain(domain: string): Promise<boolean> {
  const pool = getPool();
  const normalizedDomain = domain.toLowerCase().trim().replace(/^www\./, '');

  const result = await pool.query(
    'SELECT 1 FROM personal_domains WHERE domain = $1',
    [normalizedDomain]
  );

  return result.rows.length > 0;
}

/**
 * Get all personal domains.
 */
export async function listPersonalDomains(): Promise<PersonalDomain[]> {
  const pool = getPool();

  const result = await pool.query(
    'SELECT * FROM personal_domains ORDER BY domain ASC'
  );

  return result.rows;
}

/**
 * Get all personal domain names as a Set for efficient lookups.
 * Useful for bulk checks in domain health queries.
 */
export async function getPersonalDomainSet(): Promise<Set<string>> {
  const domains = await listPersonalDomains();
  return new Set(domains.map(d => d.domain));
}
