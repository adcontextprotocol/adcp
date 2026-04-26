/**
 * Baseline coverage for the directory MCP tools that consult the
 * federated index ahead of the property registry unification (issue
 * #3177). PR 4 will swap the FederatedIndexService readers under these
 * tools to the new publishers / adagents_authorization_overrides schema
 * shipped in #3195. Same fixtures must produce the same JSON returned
 * to the MCP client across the cutover.
 *
 * Tools covered:
 *   - lookup_domain   → FederatedIndexService.lookupDomain
 *   - list_publishers → FederatedIndexService.listAllPublishers
 *
 * `list_authorized_properties` is the upstream sales-agent tool name —
 * it lives on a sales-agent MCP, not on the directory. It is intentionally
 * out of scope here; PR 4 doesn't touch the upstream tool's contract.
 *
 * Fixtures use the *.registry-baseline.example domain suffix with an
 * `mcp-` prefix so we don't collide with the sibling baseline files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { createDirectoryToolHandlers } from '../../src/addie/mcp/directory-tools.js';

// `mcp-` prefix scopes this file's fixtures away from the sibling
// baseline files (prop-, auth-, endpoint-) so concurrent file execution
// can't trample state.
const DOMAIN_SUFFIX = '.registry-baseline.example';
const DOMAIN_PREFIX = 'mcp-';
const AGENT_PREFIX = 'https://mcp-';
const PUB_A = `${DOMAIN_PREFIX}acme${DOMAIN_SUFFIX}`;
const PUB_B = `${DOMAIN_PREFIX}pinnacle${DOMAIN_SUFFIX}`;
const AGENT_X = `${AGENT_PREFIX}sales-x.registry-baseline.example`;
const AGENT_Y = `${AGENT_PREFIX}sales-y.registry-baseline.example`;

interface LookupDomainResult {
  domain: string;
  authorized_agents: Array<{
    url: string;
    authorized_for?: string;
    source: 'registered' | 'discovered';
    member?: { slug: string; display_name: string };
  }>;
  sales_agents_claiming: Array<{
    url: string;
    source: 'registered' | 'discovered';
    member?: { slug: string; display_name: string };
  }>;
}

interface ListPublishersResult {
  publishers: Array<{
    domain: string;
    source: 'registered' | 'discovered';
    has_valid_adagents?: boolean;
    discovered_from?: { agent_url: string };
  }>;
  count: number;
}

describe('Registry reader baseline — MCP directory tools', () => {
  let pool: Pool;
  let fedDb: FederatedIndexDatabase;
  let handlers: Map<string, (args: Record<string, unknown>) => Promise<string>>;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    fedDb = new FederatedIndexDatabase();
    handlers = createDirectoryToolHandlers();
  });

  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;
  const AGENT_LIKE = `${AGENT_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE agent_url LIKE $1
          OR property_id IN (
            SELECT id FROM discovered_properties WHERE publisher_domain LIKE $2
          )`,
      [AGENT_LIKE, DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM agent_publisher_authorizations WHERE publisher_domain LIKE $1 OR agent_url LIKE $2',
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_publishers WHERE domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_agents WHERE agent_url LIKE $1',
      [AGENT_LIKE]
    );
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  // ──────────────────────────────────────────────────────────────────
  // lookup_domain
  // ──────────────────────────────────────────────────────────────────

  describe('lookup_domain', () => {
    it('returns empty arrays for an unseen domain', async () => {
      const lookup = handlers.get('lookup_domain')!;
      const raw = await lookup({ domain: PUB_A });
      const result = JSON.parse(raw) as LookupDomainResult;
      expect(result.domain).toBe(PUB_A);
      expect(result.authorized_agents).toEqual([]);
      expect(result.sales_agents_claiming).toEqual([]);
    });

    it('returns an error envelope when domain arg is missing', async () => {
      const lookup = handlers.get('lookup_domain')!;
      const raw = await lookup({});
      const result = JSON.parse(raw) as { error: string };
      expect(result.error).toMatch(/domain is required/i);
    });

    it('separates adagents_json-authorized agents from agent_claim sales claims', async () => {
      // adagents_json: AGENT_X -> PUB_A. Goes into authorized_agents.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'all',
        source: 'adagents_json',
      });
      // agent_claim: AGENT_Y -> PUB_A. Does NOT go into authorized_agents.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_Y,
        publisher_domain: PUB_A,
        source: 'agent_claim',
      });
      // sales_agents_claiming sources from discovered_publishers, not
      // agent_publisher_authorizations.
      await fedDb.upsertPublisher({
        domain: PUB_A,
        discovered_by_agent: AGENT_Y,
        has_valid_adagents: false,
      });

      const lookup = handlers.get('lookup_domain')!;
      const raw = await lookup({ domain: PUB_A });
      const result = JSON.parse(raw) as LookupDomainResult;

      // authorized_agents: only the adagents_json row. Source is 'discovered'
      // because no member profile registers AGENT_X.
      expect(result.authorized_agents.length).toBe(1);
      expect(result.authorized_agents[0]).toMatchObject({
        url: AGENT_X,
        authorized_for: 'all',
        source: 'discovered',
      });

      // sales_agents_claiming: from the discovered_publishers row.
      expect(result.sales_agents_claiming.length).toBe(1);
      expect(result.sales_agents_claiming[0]).toMatchObject({
        url: AGENT_Y,
        source: 'discovered',
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // list_publishers
  // ──────────────────────────────────────────────────────────────────

  describe('list_publishers', () => {
    it('returns an envelope with publishers + count fields', async () => {
      const list = handlers.get('list_publishers')!;
      const raw = await list({});
      const result = JSON.parse(raw) as ListPublishersResult;
      expect(Array.isArray(result.publishers)).toBe(true);
      expect(typeof result.count).toBe('number');
      expect(result.count).toBe(result.publishers.length);
    });

    it('includes our seeded publisher with source=discovered', async () => {
      await fedDb.upsertPublisher({
        domain: PUB_A,
        discovered_by_agent: AGENT_X,
        has_valid_adagents: true,
      });

      const list = handlers.get('list_publishers')!;
      const raw = await list({});
      const result = JSON.parse(raw) as ListPublishersResult;

      const ours = result.publishers.find((p) => p.domain === PUB_A);
      expect(ours).toBeTruthy();
      expect(ours!.source).toBe('discovered');
      expect(ours!.has_valid_adagents).toBe(true);
      expect(ours!.discovered_from?.agent_url).toBe(AGENT_X);
    });

    it('deduplicates by domain across multiple discovering agents', async () => {
      // Two sales agents both claim PUB_B. listAllPublishers de-dupes
      // on domain, so the publisher should appear exactly once.
      await fedDb.upsertPublisher({
        domain: PUB_B,
        discovered_by_agent: AGENT_X,
        has_valid_adagents: true,
      });
      await fedDb.upsertPublisher({
        domain: PUB_B,
        discovered_by_agent: AGENT_Y,
        has_valid_adagents: false,
      });

      const list = handlers.get('list_publishers')!;
      const raw = await list({});
      const result = JSON.parse(raw) as ListPublishersResult;
      const matching = result.publishers.filter((p) => p.domain === PUB_B);
      expect(matching.length).toBe(1);
    });
  });
});
