/**
 * Catalog-side cutover tests for agent/authorization readers (PR 4b-readers
 * of #3177).
 *
 * The baseline file (registry-reader-baseline-authorizations.test.ts) seeds
 * via `upsertAuthorization` (legacy table) and pins the I/O contract with
 * legacy-only data. This file is the dual: it seeds the catalog directly
 * (via `PublisherDatabase.upsertAdagentsCache` and direct INSERTs) and
 * asserts that the readers surface those rows. Same readers must work
 * for both fixture types during the dual-read window.
 *
 * Coverage:
 *   - Catalog-only rows surface for each reader
 *   - On legacy/catalog collisions, legacy wins (legacy data is what's
 *     returned)
 *   - Override-suppress hides the matched base row
 *   - Override-add surfaces a phantom row (publisher_domain=host_domain,
 *     evidence='override')
 *
 * Fixtures use the `cutover-` prefix on the *.registry-baseline.example
 * suffix so concurrent file execution can't trample sibling fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { PublisherDatabase, type AdagentsManifest } from '../../src/db/publisher-db.js';

const DOMAIN_SUFFIX = '.registry-baseline.example';
const DOMAIN_PREFIX = 'cutover-';
const AGENT_PREFIX = 'https://cutover-';
const PUB_A = `${DOMAIN_PREFIX}acme${DOMAIN_SUFFIX}`;
const PUB_B = `${DOMAIN_PREFIX}pinnacle${DOMAIN_SUFFIX}`;
const AGENT_X = `${AGENT_PREFIX}sales-x.registry-baseline.example`;
const AGENT_Y = `${AGENT_PREFIX}sales-y.registry-baseline.example`;
const AGENT_OVERRIDE = `${AGENT_PREFIX}override.registry-baseline.example`;

describe('Registry reader catalog cutover — catalog seeds + override layer', () => {
  let pool: Pool;
  let fedDb: FederatedIndexDatabase;
  let propDb: PropertyDatabase;
  let publisherDb: PublisherDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    fedDb = new FederatedIndexDatabase();
    propDb = new PropertyDatabase();
    publisherDb = new PublisherDatabase();
  });

  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;
  const AGENT_LIKE = `${AGENT_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    // Legacy tables.
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE property_id IN (
         SELECT id FROM discovered_properties WHERE publisher_domain LIKE $1
       )
          OR agent_url LIKE $2`,
      [DOMAIN_LIKE, AGENT_LIKE]
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
    // Catalog tables.
    await pool.query(
      'DELETE FROM adagents_authorization_overrides WHERE host_domain LIKE $1 OR agent_url_canonical LIKE $2',
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE publisher_domain LIKE $1
           OR agent_url_canonical LIKE $2
           OR property_rid IN (
             SELECT property_rid FROM catalog_properties
              WHERE created_by LIKE 'adagents_json:' || $3
           )`,
      [DOMAIN_LIKE, AGENT_LIKE, DOMAIN_LIKE]
    );
    await pool.query(
      `DELETE FROM catalog_identifiers
        WHERE property_rid IN (
          SELECT property_rid FROM catalog_properties
            WHERE created_by LIKE 'adagents_json:' || $1
        )`,
      [DOMAIN_LIKE]
    );
    await pool.query(
      `DELETE FROM catalog_properties WHERE created_by LIKE 'adagents_json:' || $1`,
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM publishers WHERE domain LIKE $1',
      [DOMAIN_LIKE]
    );
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  function manifest(
    authorized_agents: AdagentsManifest['authorized_agents'],
    properties: AdagentsManifest['properties'] = []
  ): AdagentsManifest {
    return { authorized_agents, properties };
  }

  // ──────────────────────────────────────────────────────────────────
  // Catalog-only data surfaces through each reader.
  // ──────────────────────────────────────────────────────────────────

  describe('catalog-only seeds surface through readers', () => {
    beforeEach(async () => {
      // Publisher-wide auth in catalog: AGENT_X for PUB_A.
      await publisherDb.upsertAdagentsCache({
        domain: PUB_A,
        manifest: manifest([{ url: AGENT_X, authorized_for: 'all' }]),
      });
      // Per-property auth in catalog: AGENT_Y for one property on PUB_B
      // via inline_properties variant. Plus a publisher-wide row so
      // validateAgentForProduct can read a non-'none' source.
      await publisherDb.upsertAdagentsCache({
        domain: PUB_B,
        manifest: manifest(
          [
            { url: AGENT_Y, authorized_for: 'all' },
            {
              url: AGENT_Y,
              authorization_type: 'inline_properties',
              properties: [
                {
                  property_id: 'cutover-news-b',
                  property_type: 'website',
                  name: 'Pinnacle News',
                  identifiers: [{ type: 'domain', value: `news.${PUB_B}` }],
                  tags: ['news'],
                },
              ],
            },
          ],
          [
            {
              property_id: 'cutover-news-b',
              property_type: 'website',
              name: 'Pinnacle News',
              identifiers: [{ type: 'domain', value: `news.${PUB_B}` }],
              tags: ['news'],
            },
          ]
        ),
      });
    });

    it('getAgentsForDomain surfaces catalog-only publisher-wide rows', async () => {
      const auths = await fedDb.getAgentsForDomain(PUB_A);
      expect(auths).toHaveLength(1);
      expect(auths[0]).toMatchObject({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        source: 'adagents_json',
        authorized_for: 'all',
      });
    });

    it('getDomainsForAgent surfaces catalog-only rows', async () => {
      const auths = await fedDb.getDomainsForAgent(AGENT_X);
      expect(auths).toHaveLength(1);
      expect(auths[0]).toMatchObject({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        source: 'adagents_json',
      });
    });

    it('bulkGetFirstAuthForAgents surfaces catalog-only rows', async () => {
      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_X]);
      expect(map.size).toBe(1);
      expect(map.get(AGENT_X)).toMatchObject({
        publisher_domain: PUB_A,
        source: 'adagents_json',
      });
    });

    it('getAllAgentDomainPairs includes catalog-only pairs', async () => {
      const pairs = await fedDb.getAllAgentDomainPairs();
      const match = pairs.filter((p) => p.publisher_domain === PUB_A && p.agent_url === AGENT_X);
      expect(match).toHaveLength(1);
    });

    it('getPropertiesForAgent surfaces catalog-only per-property auths', async () => {
      const props = await fedDb.getPropertiesForAgent(AGENT_Y);
      expect(props).toHaveLength(1);
      expect(props[0]).toMatchObject({
        publisher_domain: PUB_B,
        property_type: 'website',
        name: 'Pinnacle News',
      });
      expect(props[0].identifiers).toEqual([{ type: 'domain', value: `news.${PUB_B}` }]);
      expect(props[0].tags).toEqual(['news']);
    });

    it('getPublisherDomainsForAgent surfaces catalog-only per-property rows', async () => {
      const domains = await fedDb.getPublisherDomainsForAgent(AGENT_Y);
      expect(domains).toContain(PUB_B);
    });

    it('findAgentsForPropertyIdentifier surfaces catalog-only rows', async () => {
      const matches = await fedDb.findAgentsForPropertyIdentifier('domain', `news.${PUB_B}`);
      const filtered = matches.filter((m) => m.agent_url === AGENT_Y);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].publisher_domain).toBe(PUB_B);
      expect(filtered[0].property.name).toBe('Pinnacle News');
    });

    it('isPropertyAuthorizedForAgent surfaces catalog-only rows', async () => {
      const result = await fedDb.isPropertyAuthorizedForAgent(
        AGENT_Y,
        'domain',
        `news.${PUB_B}`
      );
      expect(result.authorized).toBe(true);
      expect(result.publisher_domain).toBe(PUB_B);
    });

    it('getAgentAuthorizationsForDomain surfaces catalog-only per-property rows (property-db)', async () => {
      const rows = await propDb.getAgentAuthorizationsForDomain(PUB_B);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agent_url: AGENT_Y,
        property_name: 'Pinnacle News',
      });
    });

    it('validateAgentForProduct selection_type=all reports catalog-only counts via the unioned property reader', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_Y, [
        { publisher_domain: PUB_B, selection_type: 'all' },
      ]);
      expect(result.total_requested).toBe(1);
      expect(result.total_authorized).toBe(1);
      expect(result.authorized).toBe(true);
      expect(result.selectors[0].source).toBe('adagents_json');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Legacy wins on collision: when a (key) exists in both arms, the
  // legacy row's data is what surfaces.
  // ──────────────────────────────────────────────────────────────────

  describe('legacy wins on collision', () => {
    it('getAgentsForDomain returns legacy authorized_for when both arms have a (agent, publisher, source)', async () => {
      // Catalog row first.
      await publisherDb.upsertAdagentsCache({
        domain: PUB_A,
        manifest: manifest([{ url: AGENT_X, authorized_for: 'catalog-says-display' }]),
      });
      // Legacy row second with a different authorized_for.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'legacy-says-video',
        source: 'adagents_json',
      });

      const auths = await fedDb.getAgentsForDomain(PUB_A);
      expect(auths).toHaveLength(1);
      expect(auths[0].authorized_for).toBe('legacy-says-video');
    });

    it('getDomainsForAgent prefers legacy data on collision', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: PUB_A,
        manifest: manifest([{ url: AGENT_X, authorized_for: 'catalog-side' }]),
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'legacy-side',
        source: 'adagents_json',
      });
      const auths = await fedDb.getDomainsForAgent(AGENT_X);
      expect(auths).toHaveLength(1);
      expect(auths[0].authorized_for).toBe('legacy-side');
    });

    it('bulkGetFirstAuthForAgents returns the legacy row on collision', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: PUB_A,
        manifest: manifest([{ url: AGENT_X, authorized_for: 'catalog-side' }]),
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'legacy-side',
        source: 'adagents_json',
      });
      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_X]);
      expect(map.get(AGENT_X)?.authorized_for).toBe('legacy-side');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Override-suppress: hides matched base catalog rows.
  // ──────────────────────────────────────────────────────────────────

  describe('override-suppress hides matched base rows', () => {
    beforeEach(async () => {
      await publisherDb.upsertAdagentsCache({
        domain: PUB_A,
        manifest: manifest([
          { url: AGENT_X, authorized_for: 'all' },
        ]),
      });
    });

    it('host-wide suppress hides the catalog row from getAgentsForDomain', async () => {
      // Sanity: row exists before the override.
      let auths = await fedDb.getAgentsForDomain(PUB_A);
      expect(auths.map((a) => a.agent_url)).toContain(AGENT_X);

      // Suppress the host-wide auth.
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type,
            override_reason, justification, approved_by_user_id)
         VALUES ($1, $2, $2, 'suppress', 'bad_actor',
                 'test fixture: suppress catalog row', 'test-user')`,
        [PUB_A, AGENT_X]
      );

      auths = await fedDb.getAgentsForDomain(PUB_A);
      expect(auths.map((a) => a.agent_url)).not.toContain(AGENT_X);
    });

    it('host-wide suppress hides the catalog row from getDomainsForAgent', async () => {
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type,
            override_reason, justification, approved_by_user_id)
         VALUES ($1, $2, $2, 'suppress', 'bad_actor',
                 'test fixture: suppress catalog row', 'test-user')`,
        [PUB_A, AGENT_X]
      );

      const auths = await fedDb.getDomainsForAgent(AGENT_X);
      const matching = auths.filter((a) => a.publisher_domain === PUB_A);
      expect(matching).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Override-add: surfaces a phantom row.
  // ──────────────────────────────────────────────────────────────────

  describe('override-add surfaces phantom rows', () => {
    it('add override surfaces in getAgentsForDomain even with no base catalog row', async () => {
      // No publishers row, no catalog auth row — just an override.
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type,
            override_reason, justification, authorized_for, approved_by_user_id)
         VALUES ($1, $2, $2, 'add', 'file_broken',
                 'test fixture: add phantom row', 'display', 'test-user')`,
        [PUB_A, AGENT_OVERRIDE]
      );

      const auths = await fedDb.getAgentsForDomain(PUB_A);
      const phantom = auths.find((a) => a.agent_url === AGENT_OVERRIDE);
      expect(phantom).toBeDefined();
      expect(phantom!.publisher_domain).toBe(PUB_A);
      // 'override' evidence maps to legacy 'adagents_json' source.
      expect(phantom!.source).toBe('adagents_json');
      expect(phantom!.authorized_for).toBe('display');
    });

    it('add override surfaces in getDomainsForAgent', async () => {
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type,
            override_reason, justification, authorized_for, approved_by_user_id)
         VALUES ($1, $2, $2, 'add', 'file_broken',
                 'test fixture: add phantom row', 'display', 'test-user')`,
        [PUB_A, AGENT_OVERRIDE]
      );

      const auths = await fedDb.getDomainsForAgent(AGENT_OVERRIDE);
      const phantom = auths.find((a) => a.publisher_domain === PUB_A);
      expect(phantom).toBeDefined();
      expect(phantom!.source).toBe('adagents_json');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Cross-arm dedup: same agent in both arms produces one map entry.
  // ──────────────────────────────────────────────────────────────────

  describe('bulkGetFirstAuthForAgents cross-arm dedup', () => {
    it('one map entry per agent when both arms have rows for that agent', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: PUB_B,
        manifest: manifest([{ url: AGENT_X, authorized_for: 'catalog-side' }]),
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'legacy-side',
        source: 'adagents_json',
      });

      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_X]);
      expect(map.size).toBe(1);
      // Legacy wins.
      expect(map.get(AGENT_X)?.authorized_for).toBe('legacy-side');
      expect(map.get(AGENT_X)?.publisher_domain).toBe(PUB_A);
    });
  });
});
