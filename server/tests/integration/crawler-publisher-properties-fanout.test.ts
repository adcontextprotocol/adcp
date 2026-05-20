/**
 * Integration tests for the crawler's publisher_properties fan-out
 * (adcp#4836 follow-up). When a manager file (cafemedia-shape) declares
 * `authorization_type: 'publisher_properties'` with `publisher_domains[]`,
 * the crawler synthesizes:
 *   - one `agent_publisher_authorizations` row per listed child publisher
 *     (source='adagents_json' — the manager file IS the authoritative
 *     declaration per the inline-resolution rule in adcp#4825)
 *   - one `publishers` row per child with `discovery_method =
 *     'adagents_authoritative'` and `manager_domain = <host>`
 *
 * Tests `recordChildPublisherFromManager` (DB) and the helper method
 * `fanOutPublisherPropertiesAuthorizations` (crawler), reading state
 * directly from Postgres so the SQL-side invariants hold.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const MANAGER = `mgr-${RUN_SUFFIX}.fanout.example`;
const CHILD_A = `child-a-${RUN_SUFFIX}.fanout.example`;
const CHILD_B = `child-b-${RUN_SUFFIX}.fanout.example`;
const CHILD_C = `child-c-${RUN_SUFFIX}.fanout.example`;
const AGENT = `https://fanout-agent-${RUN_SUFFIX}.example`;

const ALL_DOMAINS = [MANAGER, CHILD_A, CHILD_B, CHILD_C];

describe('crawler publisher_properties fan-out (integration)', () => {
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
      'DELETE FROM agent_publisher_authorizations WHERE publisher_domain = ANY($1::text[]) OR agent_url = $2',
      [ALL_DOMAINS, AGENT],
    );
    await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [ALL_DOMAINS]);
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  describe('PublisherDatabase.recordChildPublisherFromManager', () => {
    it('upserts a child row with discovery_method=adagents_authoritative + manager_domain', async () => {
      await publisherDb.recordChildPublisherFromManager({
        childDomain: CHILD_A,
        managerDomain: MANAGER,
      });
      const result = await query<{
        domain: string;
        source_type: string;
        discovery_method: string | null;
        manager_domain: string | null;
        adagents_json: unknown | null;
      }>(
        'SELECT domain, source_type, discovery_method, manager_domain, adagents_json FROM publishers WHERE domain = $1',
        [CHILD_A],
      );
      expect(result.rows[0]).toMatchObject({
        domain: CHILD_A,
        source_type: 'community',
        discovery_method: 'adagents_authoritative',
        manager_domain: MANAGER,
        adagents_json: null, // no blob — child was never independently fetched
      });
    });

    it('does not self-attribute (manager == child is a no-op)', async () => {
      await publisherDb.recordChildPublisherFromManager({
        childDomain: MANAGER,
        managerDomain: MANAGER,
      });
      const result = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM publishers WHERE domain = $1',
        [MANAGER],
      );
      expect(result.rows[0]?.count).toBe('0');
    });

    it('does not overwrite a child that already has its own adagents_json cached', async () => {
      // Seed a stronger row: child was independently crawled, has its own
      // adagents_json blob and discovery_method=direct.
      await pool.query(
        `INSERT INTO publishers (domain, adagents_json, source_type, last_validated, discovery_method)
         VALUES ($1, '{"authorized_agents":[]}'::jsonb, 'adagents_json', NOW(), 'direct')`,
        [CHILD_A],
      );

      // Fan-out should NOT downgrade it to adagents_authoritative.
      await publisherDb.recordChildPublisherFromManager({
        childDomain: CHILD_A,
        managerDomain: MANAGER,
      });

      const result = await query<{
        discovery_method: string;
        manager_domain: string | null;
        adagents_json: unknown;
      }>(
        'SELECT discovery_method, manager_domain, adagents_json FROM publishers WHERE domain = $1',
        [CHILD_A],
      );
      expect(result.rows[0]).toMatchObject({
        discovery_method: 'direct', // direct crawl wins
        manager_domain: null,
        adagents_json: { authorized_agents: [] },
      });
    });

    it('canonicalizes the input domain (lowercases, strips trailing dot)', async () => {
      await publisherDb.recordChildPublisherFromManager({
        childDomain: `  ${CHILD_A.toUpperCase()}.  `,
        managerDomain: `${MANAGER.toUpperCase()}.`,
      });
      const result = await query<{ domain: string; manager_domain: string }>(
        'SELECT domain, manager_domain FROM publishers WHERE domain = $1',
        [CHILD_A],
      );
      expect(result.rows[0]?.domain).toBe(CHILD_A);
      expect(result.rows[0]?.manager_domain).toBe(MANAGER);
    });
  });

  describe('crawler.fanOutPublisherPropertiesAuthorizations (end-to-end)', () => {
    // This exercises the crawler's helper via the public seam — write
    // a manager-shaped adagents.json blob to the cache for MANAGER, then
    // simulate the crawler's loop by calling fanOut for one
    // authorized_agents[] entry. Verifies both the publishers row writes
    // and the agent_publisher_authorizations rows that the directory
    // inverse-lookup endpoint reads.

    async function fanOut(opts: {
      agentUrl: string;
      managerDomain: string;
      publisher_properties: Array<Record<string, unknown>>;
    }) {
      // Reach into the helper via dynamic import so tests don't need a
      // full CrawlerService boot — we want to test the SQL behavior, not
      // the singleton lifecycle.
      const { CrawlerService } = await import('../../src/crawler.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = (CrawlerService as any).prototype;
      // Bind a minimal `this` — the helper only touches
      // this.publisherDb.recordChildPublisherFromManager and
      // this.federatedIndex.recordAgentFromAdagentsJson.
      const { FederatedIndexService } = await import('../../src/federated-index.js');
      const ctx = {
        publisherDb,
        federatedIndex: new FederatedIndexService(),
      };
      await proto.fanOutPublisherPropertiesAuthorizations.call(
        ctx,
        {
          url: opts.agentUrl,
          authorization_type: 'publisher_properties',
          publisher_properties: opts.publisher_properties,
        },
        opts.managerDomain,
      );
    }

    it('fans publisher_domains[] into per-child authz rows and publisher rows', async () => {
      await fanOut({
        agentUrl: AGENT,
        managerDomain: MANAGER,
        publisher_properties: [
          {
            selection_type: 'by_tag',
            property_tags: ['managed'],
            publisher_domains: [CHILD_A, CHILD_B, CHILD_C],
          },
        ],
      });

      // publishers rows
      const pubs = await query<{ domain: string; discovery_method: string; manager_domain: string }>(
        `SELECT domain, discovery_method, manager_domain FROM publishers
          WHERE domain = ANY($1::text[]) ORDER BY domain`,
        [[CHILD_A, CHILD_B, CHILD_C]],
      );
      expect(pubs.rows).toHaveLength(3);
      for (const r of pubs.rows) {
        expect(r.discovery_method).toBe('adagents_authoritative');
        expect(r.manager_domain).toBe(MANAGER);
      }

      // agent_publisher_authorizations rows
      const auths = await query<{ publisher_domain: string; source: string }>(
        `SELECT publisher_domain, source FROM agent_publisher_authorizations
          WHERE agent_url = $1 ORDER BY publisher_domain`,
        [AGENT],
      );
      expect(auths.rows.map(r => r.publisher_domain)).toEqual([CHILD_A, CHILD_B, CHILD_C].sort());
      for (const r of auths.rows) {
        expect(r.source).toBe('adagents_json');
      }
    });

    it('honors singular publisher_domain in a selector', async () => {
      await fanOut({
        agentUrl: AGENT,
        managerDomain: MANAGER,
        publisher_properties: [
          { selection_type: 'all', publisher_domain: CHILD_A },
        ],
      });
      const auths = await query<{ publisher_domain: string }>(
        'SELECT publisher_domain FROM agent_publisher_authorizations WHERE agent_url = $1',
        [AGENT],
      );
      expect(auths.rows.map(r => r.publisher_domain)).toEqual([CHILD_A]);
    });

    it('skips entries where authorization_type is not publisher_properties', async () => {
      const { CrawlerService } = await import('../../src/crawler.js');
      const { FederatedIndexService } = await import('../../src/federated-index.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = (CrawlerService as any).prototype;
      const ctx = { publisherDb, federatedIndex: new FederatedIndexService() };

      await proto.fanOutPublisherPropertiesAuthorizations.call(
        ctx,
        {
          url: AGENT,
          authorization_type: 'property_ids',
          property_ids: ['p1', 'p2'],
        },
        MANAGER,
      );
      const auths = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM agent_publisher_authorizations WHERE agent_url = $1',
        [AGENT],
      );
      expect(auths.rows[0]?.count).toBe('0');
    });

    it('drops the manager from the child set even if listed in publisher_domains[]', async () => {
      await fanOut({
        agentUrl: AGENT,
        managerDomain: MANAGER,
        publisher_properties: [
          {
            selection_type: 'by_tag',
            property_tags: ['managed'],
            publisher_domains: [MANAGER, CHILD_A],
          },
        ],
      });
      const auths = await query<{ publisher_domain: string }>(
        'SELECT publisher_domain FROM agent_publisher_authorizations WHERE agent_url = $1 ORDER BY publisher_domain',
        [AGENT],
      );
      expect(auths.rows.map(r => r.publisher_domain)).toEqual([CHILD_A]);
    });

    it('is idempotent — re-running does not duplicate rows', async () => {
      const call = () => fanOut({
        agentUrl: AGENT,
        managerDomain: MANAGER,
        publisher_properties: [
          { selection_type: 'all', publisher_domains: [CHILD_A, CHILD_B] },
        ],
      });
      await call();
      await call();
      await call();

      const auths = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM agent_publisher_authorizations WHERE agent_url = $1',
        [AGENT],
      );
      expect(auths.rows[0]?.count).toBe('2');
      const pubs = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM publishers WHERE manager_domain = $1',
        [MANAGER],
      );
      expect(pubs.rows[0]?.count).toBe('2');
    });
  });
});
