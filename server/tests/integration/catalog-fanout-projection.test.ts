/**
 * Integration test for catalog projection of publisher_properties
 * fan-out rows (adcp#4841).
 *
 * `recordCatalogFanoutAuthorization` writes the edge into
 * `catalog_agent_authorizations` with the new `adagents_authoritative`
 * evidence value (migration 488). This is the projection that lets
 * partner-sync endpoints (`/registry/authorizations`,
 * `/registry/authorizations/snapshot`) see manager-asserted children.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT_URL = `https://catalog-agent-${RUN_SUFFIX}.example`;
const CHILD = `child-${RUN_SUFFIX}.catalog-fanout.example`;

describe('catalog fan-out projection — recordCatalogFanoutAuthorization (#4841)', () => {
  let pool: Pool;
  let publisherDb: PublisherDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    publisherDb = new PublisherDatabase();
  });

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE agent_url_canonical = LOWER(RTRIM(BTRIM($1), '/'))`,
      [AGENT_URL],
    );
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  it('writes a catalog row with evidence=adagents_authoritative + created_by=system', async () => {
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: AGENT_URL,
      childDomain: CHILD,
      authorizedFor: 'Test scope description',
    });

    const result = await query<{
      agent_url: string;
      agent_url_canonical: string;
      publisher_domain: string;
      authorized_for: string;
      evidence: string;
      created_by: string;
      property_rid: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT agent_url, agent_url_canonical, publisher_domain, authorized_for,
              evidence, created_by, property_rid, deleted_at
         FROM catalog_agent_authorizations
        WHERE agent_url_canonical = LOWER(RTRIM(BTRIM($1), '/'))
          AND publisher_domain = $2`,
      [AGENT_URL, CHILD],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      agent_url: AGENT_URL,
      agent_url_canonical: AGENT_URL.toLowerCase(),
      publisher_domain: CHILD,
      authorized_for: 'Test scope description',
      evidence: 'adagents_authoritative',
      created_by: 'system',
      property_rid: null, // publisher-wide
      deleted_at: null,
    });
  });

  it('is idempotent — second call updates authorized_for instead of duplicating', async () => {
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: AGENT_URL,
      childDomain: CHILD,
      authorizedFor: 'first',
    });
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: AGENT_URL,
      childDomain: CHILD,
      authorizedFor: 'second',
    });
    const result = await query<{ count: string; authorized_for: string }>(
      `SELECT COUNT(*)::text AS count, MAX(authorized_for) AS authorized_for
         FROM catalog_agent_authorizations
        WHERE agent_url_canonical = LOWER(RTRIM(BTRIM($1), '/'))
          AND publisher_domain = $2
          AND evidence = 'adagents_authoritative'`,
      [AGENT_URL, CHILD],
    );
    expect(result.rows[0]?.count).toBe('1');
    expect(result.rows[0]?.authorized_for).toBe('second');
  });

  it('coexists with adagents_json evidence for the same (agent, publisher) pair', async () => {
    // A child that ALSO has its own adagents.json directly authorizing
    // this agent would carry evidence='adagents_json'. The fan-out row
    // with evidence='adagents_authoritative' should be a separate row
    // (different evidence) — consumers can filter by trust level.
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, authorized_for, evidence, created_by)
       VALUES ($1, LOWER(RTRIM(BTRIM($1), '/')), $2, 'direct', 'adagents_json', 'system')`,
      [AGENT_URL, CHILD],
    );
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: AGENT_URL,
      childDomain: CHILD,
      authorizedFor: 'manager-asserted',
    });
    const result = await query<{ evidence: string; authorized_for: string }>(
      `SELECT evidence, authorized_for FROM catalog_agent_authorizations
        WHERE agent_url_canonical = LOWER(RTRIM(BTRIM($1), '/'))
          AND publisher_domain = $2
          AND deleted_at IS NULL
        ORDER BY evidence`,
      [AGENT_URL, CHILD],
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(r => r.evidence)).toEqual(['adagents_authoritative', 'adagents_json']);
  });

  it('rejects an invalid agent_url silently (skips write, does not throw)', async () => {
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: '  ',
      childDomain: CHILD,
    });
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM catalog_agent_authorizations
        WHERE publisher_domain = $1`,
      [CHILD],
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('canonicalizes the child domain (lowercases + strips trailing dot)', async () => {
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: AGENT_URL,
      childDomain: `  ${CHILD.toUpperCase()}.  `,
    });
    const result = await query<{ publisher_domain: string }>(
      `SELECT publisher_domain FROM catalog_agent_authorizations
        WHERE agent_url_canonical = LOWER(RTRIM(BTRIM($1), '/'))
          AND evidence = 'adagents_authoritative'`,
      [AGENT_URL],
    );
    expect(result.rows[0]?.publisher_domain).toBe(CHILD);
  });

  it('appears in v_effective_agent_authorizations with evidence preserved', async () => {
    await publisherDb.recordCatalogFanoutAuthorization({
      agentUrl: AGENT_URL,
      childDomain: CHILD,
    });
    const result = await query<{ evidence: string; publisher_domain: string }>(
      `SELECT evidence, publisher_domain
         FROM v_effective_agent_authorizations
        WHERE agent_url_canonical = LOWER(RTRIM(BTRIM($1), '/'))
          AND publisher_domain = $2`,
      [AGENT_URL, CHILD],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.evidence).toBe('adagents_authoritative');
  });
});
