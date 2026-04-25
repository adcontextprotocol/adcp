/**
 * Integration tests for PR 2 of #3177: the adagents.json crawler now caches
 * the manifest into publishers (migration 432) and projects the parsed
 * properties into catalog_properties + catalog_identifiers in the same
 * transaction.
 *
 * The legacy discovered_properties / agent_property_authorizations writes
 * (migration 026) still happen — dual-write for one release as a fallback
 * before PR 5 drops the old tables.
 *
 * Closes the gap surfaced by Setupad escalation #218: properties that landed
 * in discovered_properties via the crawler never made it into the catalog
 * (migration 336 was a one-time seed). With this PR, every successful crawl
 * lands in both places.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';
import { FederatedIndexService } from '../../src/federated-index.js';
import type { Pool } from 'pg';

const TEST_DOMAIN = 'crawler-cache.example.com';
const TEST_AGENT = 'https://agent.crawler-cache.example.com/mcp';

const FIXTURE_MANIFEST = {
  $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
  authorized_agents: [
    {
      url: TEST_AGENT,
      authorized_for: 'Display inventory across all properties',
      property_ids: ['site_main', 'app_ios'],
    },
  ],
  properties: [
    {
      property_id: 'site_main',
      property_type: 'website',
      name: 'Crawler Cache Main Site',
      identifiers: [
        { type: 'domain', value: TEST_DOMAIN },
        { type: 'subdomain', value: `news.${TEST_DOMAIN}` },
      ],
      tags: ['flagship'],
    },
    {
      property_id: 'app_ios',
      property_type: 'mobile_app',
      name: 'Crawler Cache iOS App',
      identifiers: [{ type: 'ios_bundle', value: 'com.example.crawlercache' }],
    },
  ],
  last_updated: '2026-04-25T00:00:00Z',
};

describe('Registry crawler cache (PR 2 of #3177)', () => {
  let pool: Pool;
  let publisherDb: PublisherDatabase;
  let federatedIndex: FederatedIndexService;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    publisherDb = new PublisherDatabase();
    federatedIndex = new FederatedIndexService();
  });

  // Scope cleanup tightly so parallel runs of other tests sharing the
  // .example.com pattern don't trample our fixtures.
  async function clearTestFixtures() {
    await pool.query(
      `DELETE FROM catalog_identifiers WHERE identifier_value = $1
                                          OR identifier_value = $2
                                          OR identifier_value = $3`,
      [TEST_DOMAIN, `news.${TEST_DOMAIN}`, 'com.example.crawlercache']
    );
    await pool.query(
      `DELETE FROM catalog_properties WHERE created_by = $1`,
      [`adagents_json:${TEST_DOMAIN}`]
    );
    await pool.query('DELETE FROM publishers WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query(
      'DELETE FROM agent_property_authorizations WHERE agent_url = $1',
      [TEST_AGENT]
    );
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain = $1',
      [TEST_DOMAIN]
    );
    await pool.query('DELETE FROM discovered_agents WHERE agent_url = $1', [TEST_AGENT]);
    await pool.query(
      'DELETE FROM agent_publisher_authorizations WHERE publisher_domain = $1',
      [TEST_DOMAIN]
    );
  }

  beforeEach(async () => {
    await clearTestFixtures();
  });

  afterAll(async () => {
    await clearTestFixtures();
    await closeDatabase();
  });

  describe('publishers cache', () => {
    it('upserts publishers row with adagents_json source_type and manifest body', async () => {
      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });

      const { rows } = await pool.query<{
        domain: string;
        adagents_json: unknown;
        source_type: string;
        last_validated: Date | null;
      }>(
        `SELECT domain, adagents_json, source_type, last_validated
           FROM publishers WHERE domain = $1`,
        [TEST_DOMAIN]
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].source_type).toBe('adagents_json');
      expect(rows[0].last_validated).not.toBeNull();

      // The manifest body comes back parsed (JSONB), not as a string.
      const stored = rows[0].adagents_json as typeof FIXTURE_MANIFEST;
      expect(stored.authorized_agents).toEqual(FIXTURE_MANIFEST.authorized_agents);
      expect(stored.properties).toHaveLength(2);
      expect(stored.last_updated).toBe('2026-04-25T00:00:00Z');
    });

    it('preserves org/ownership metadata on re-crawl (ON CONFLICT semantics)', async () => {
      // Seed a row that was registered by an org BEFORE the crawler runs.
      await pool.query(
        `INSERT INTO publishers (domain, source_type, workos_organization_id, created_by_email)
           VALUES ($1, 'community', 'org_test_publisher_owner', 'owner@example.com')`,
        [TEST_DOMAIN]
      );

      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });

      const { rows } = await pool.query<{
        source_type: string;
        workos_organization_id: string | null;
        created_by_email: string | null;
      }>(
        `SELECT source_type, workos_organization_id, created_by_email
           FROM publishers WHERE domain = $1`,
        [TEST_DOMAIN]
      );

      expect(rows[0].source_type).toBe('adagents_json');
      expect(rows[0].workos_organization_id).toBe('org_test_publisher_owner');
      expect(rows[0].created_by_email).toBe('owner@example.com');
    });
  });

  describe('catalog projection', () => {
    it('materializes catalog_properties with adagents_url and authoritative source', async () => {
      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });

      const { rows } = await pool.query<{
        property_rid: string;
        property_id: string | null;
        classification: string;
        source: string;
        status: string;
        adagents_url: string | null;
      }>(
        `SELECT property_rid, property_id, classification, source, status, adagents_url
           FROM catalog_properties
          WHERE created_by = $1
          ORDER BY property_id NULLS LAST`,
        [`adagents_json:${TEST_DOMAIN}`]
      );

      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r.property_id);
      expect(ids).toContain('site_main');
      expect(ids).toContain('app_ios');
      for (const row of rows) {
        expect(row.classification).toBe('property');
        expect(row.source).toBe('authoritative');
        expect(row.status).toBe('active');
        expect(row.adagents_url).toBe(`https://${TEST_DOMAIN}/.well-known/adagents.json`);
      }
    });

    it('materializes catalog_identifiers with evidence=adagents_json and confidence=authoritative', async () => {
      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });

      const { rows } = await pool.query<{
        identifier_type: string;
        identifier_value: string;
        evidence: string;
        confidence: string;
      }>(
        `SELECT identifier_type, identifier_value, evidence, confidence
           FROM catalog_identifiers
          WHERE identifier_value IN ($1, $2, $3)
          ORDER BY identifier_value`,
        [TEST_DOMAIN, `news.${TEST_DOMAIN}`, 'com.example.crawlercache']
      );

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.evidence).toBe('adagents_json');
        expect(row.confidence).toBe('authoritative');
      }
      const valuesByType = new Map(rows.map((r) => [r.identifier_value, r.identifier_type]));
      expect(valuesByType.get(TEST_DOMAIN)).toBe('domain');
      expect(valuesByType.get(`news.${TEST_DOMAIN}`)).toBe('subdomain');
      expect(valuesByType.get('com.example.crawlercache')).toBe('ios_bundle');
    });

    it('normalizes identifier values to lowercase before catalog insert', async () => {
      // catalog_identifiers has a chk_identifier_lowercase CHECK; the writer
      // must run normalizeIdentifier so the row inserts cleanly even when the
      // publisher's adagents.json declares a mixed-case value.
      const mixedCaseManifest = {
        ...FIXTURE_MANIFEST,
        properties: [
          {
            property_id: 'site_main',
            property_type: 'website',
            name: 'Mixed Case Site',
            identifiers: [{ type: 'ios_bundle', value: 'COM.EXAMPLE.CRAWLERCACHE' }],
          },
        ],
      };

      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: mixedCaseManifest });

      const { rows } = await pool.query<{ identifier_value: string }>(
        `SELECT identifier_value FROM catalog_identifiers
          WHERE identifier_value = 'com.example.crawlercache'`
      );
      expect(rows).toHaveLength(1);
    });

    it('reuses property_rid on re-crawl rather than forking identity', async () => {
      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });
      const first = await pool.query<{ property_rid: string }>(
        `SELECT property_rid FROM catalog_identifiers
          WHERE identifier_type = 'domain' AND identifier_value = $1`,
        [TEST_DOMAIN]
      );
      expect(first.rows).toHaveLength(1);
      const ridAfterFirstCrawl = first.rows[0].property_rid;

      // Second crawl with the same manifest: no new catalog_properties row,
      // and the existing identifier still points at the same rid.
      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });

      const second = await pool.query<{ property_rid: string }>(
        `SELECT property_rid FROM catalog_identifiers
          WHERE identifier_type = 'domain' AND identifier_value = $1`,
        [TEST_DOMAIN]
      );
      expect(second.rows[0].property_rid).toBe(ridAfterFirstCrawl);

      const propCount = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM catalog_properties
          WHERE created_by = $1`,
        [`adagents_json:${TEST_DOMAIN}`]
      );
      expect(propCount.rows[0].c).toBe('2');
    });
  });

  describe('dual-write fallback to legacy tables', () => {
    it('still writes discovered_properties and agent_property_authorizations alongside the new cache', async () => {
      // Mirror what crawler.ts does for a successful adagents.json crawl:
      // call the publisher cache writer AND the federated-index writer.
      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: FIXTURE_MANIFEST });

      for (const authorizedAgent of FIXTURE_MANIFEST.authorized_agents) {
        await federatedIndex.recordAgentFromAdagentsJson(
          authorizedAgent.url,
          TEST_DOMAIN,
          authorizedAgent.authorized_for,
          authorizedAgent.property_ids
        );
        for (const prop of FIXTURE_MANIFEST.properties) {
          await federatedIndex.recordProperty(
            {
              property_id: prop.property_id,
              publisher_domain: TEST_DOMAIN,
              property_type: prop.property_type,
              name: prop.name,
              identifiers: prop.identifiers,
              tags: prop.tags,
            },
            authorizedAgent.url,
            authorizedAgent.authorized_for
          );
        }
      }

      // New tables
      const pub = await pool.query<{ source_type: string }>(
        `SELECT source_type FROM publishers WHERE domain = $1`,
        [TEST_DOMAIN]
      );
      expect(pub.rows[0].source_type).toBe('adagents_json');

      // Legacy tables
      const legacyProps = await pool.query<{ name: string; property_id: string | null }>(
        `SELECT name, property_id FROM discovered_properties WHERE publisher_domain = $1
          ORDER BY property_id NULLS LAST`,
        [TEST_DOMAIN]
      );
      expect(legacyProps.rows).toHaveLength(2);
      expect(legacyProps.rows.map((r) => r.property_id)).toEqual(
        expect.arrayContaining(['site_main', 'app_ios'])
      );

      const legacyAuth = await pool.query<{ agent_url: string }>(
        `SELECT apa.agent_url
           FROM agent_property_authorizations apa
           JOIN discovered_properties dp ON dp.id = apa.property_id
          WHERE dp.publisher_domain = $1`,
        [TEST_DOMAIN]
      );
      expect(legacyAuth.rows.map((r) => r.agent_url)).toEqual(
        expect.arrayContaining([TEST_AGENT])
      );
    });
  });
});
