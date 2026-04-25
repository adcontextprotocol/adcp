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
// Cross-publisher fixtures used by the tenant-isolation tests.
const VICTIM_DOMAIN = 'victim.crawler-cache.example.com';
const ATTACKER_DOMAIN = 'attacker.crawler-cache.example.com';

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
  const TEST_CREATED_BY = [
    `adagents_json:${TEST_DOMAIN}`,
    `adagents_json:${VICTIM_DOMAIN}`,
    `adagents_json:${ATTACKER_DOMAIN}`,
    'test:tenant-isolation-seed',
  ];
  const TEST_DOMAINS = [TEST_DOMAIN, VICTIM_DOMAIN, ATTACKER_DOMAIN];

  async function clearTestFixtures() {
    // Identifiers must clear before properties — catalog_identifiers FKs to
    // catalog_properties. Delete via the property_rid join so any identifier
    // value (including ones the tests didn't list explicitly) gets caught.
    await pool.query(
      `DELETE FROM catalog_identifiers
         WHERE property_rid IN (
           SELECT property_rid FROM catalog_properties
            WHERE created_by = ANY($1::text[])
         )`,
      [TEST_CREATED_BY]
    );
    await pool.query(
      `DELETE FROM catalog_properties WHERE created_by = ANY($1::text[])`,
      [TEST_CREATED_BY]
    );
    await pool.query(
      `DELETE FROM publishers WHERE domain = ANY($1::text[])`,
      [TEST_DOMAINS]
    );
    await pool.query(
      'DELETE FROM agent_property_authorizations WHERE agent_url = $1',
      [TEST_AGENT]
    );
    await pool.query(
      `DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])`,
      [TEST_DOMAINS]
    );
    await pool.query('DELETE FROM discovered_agents WHERE agent_url = $1', [TEST_AGENT]);
    await pool.query(
      `DELETE FROM agent_publisher_authorizations WHERE publisher_domain = ANY($1::text[])`,
      [TEST_DOMAINS]
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

    it('lowercases rss_url path so chk_identifier_lowercase doesn\'t silently roll back', async () => {
      // normalizeRssUrl preserves URL path case ("Feed.xml" stays mixed). Without
      // the writer's defensive lowercase, this triggers a 23514 check_violation
      // mid-transaction and the entire crawl is silently rolled back.
      const rssManifest = {
        ...FIXTURE_MANIFEST,
        properties: [
          {
            property_id: 'feed_main',
            property_type: 'podcast',
            name: 'Crawler Cache Feed',
            identifiers: [{ type: 'rss_url', value: `https://${TEST_DOMAIN}/Feed.xml` }],
          },
        ],
      };

      await publisherDb.upsertAdagentsCache({ domain: TEST_DOMAIN, manifest: rssManifest });

      const { rows } = await pool.query<{ identifier_value: string }>(
        `SELECT identifier_value FROM catalog_identifiers
          WHERE identifier_type = 'rss_url' AND property_rid IN (
            SELECT property_rid FROM catalog_properties WHERE created_by = $1
          )`,
        [`adagents_json:${TEST_DOMAIN}`]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].identifier_value).toBe(`https://${TEST_DOMAIN}/feed.xml`);
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

  describe('tenant isolation', () => {
    it('refuses to rebind a victim\'s identifier when another publisher claims it', async () => {
      // Victim claims its own domain.
      await publisherDb.upsertAdagentsCache({
        domain: VICTIM_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'victim_site',
              property_type: 'website',
              name: 'Victim Site',
              identifiers: [{ type: 'domain', value: VICTIM_DOMAIN }],
            },
          ],
        },
      });

      const beforeAttacker = await pool.query<{ property_rid: string; created_by: string | null }>(
        `SELECT cp.property_rid, cp.created_by
           FROM catalog_identifiers ci
           JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
          WHERE ci.identifier_type = 'domain' AND ci.identifier_value = $1`,
        [VICTIM_DOMAIN]
      );
      expect(beforeAttacker.rows).toHaveLength(1);
      const victimRid = beforeAttacker.rows[0].property_rid;
      expect(beforeAttacker.rows[0].created_by).toBe(`adagents_json:${VICTIM_DOMAIN}`);

      // Attacker publishes a manifest naming the victim's domain alongside its own.
      await publisherDb.upsertAdagentsCache({
        domain: ATTACKER_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'attacker_bundle',
              property_type: 'website',
              name: 'Attacker Bundle',
              identifiers: [
                { type: 'domain', value: VICTIM_DOMAIN },
                { type: 'domain', value: ATTACKER_DOMAIN },
              ],
            },
          ],
        },
      });

      // Victim's identifier still points at the victim's rid; not rebound.
      const victimIdentifier = await pool.query<{ property_rid: string }>(
        `SELECT property_rid FROM catalog_identifiers
          WHERE identifier_type = 'domain' AND identifier_value = $1`,
        [VICTIM_DOMAIN]
      );
      expect(victimIdentifier.rows[0].property_rid).toBe(victimRid);

      // Attacker's own identifier was NOT bound to the victim's rid (refusal
      // skipped the whole projection — neither side of the merge lands).
      const attackerIdentifier = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_identifiers
          WHERE identifier_type = 'domain' AND identifier_value = $1`,
        [ATTACKER_DOMAIN]
      );
      expect(attackerIdentifier.rows[0].count).toBe('0');

      // Victim's catalog property is still authored by the victim, not the attacker.
      const victimProperty = await pool.query<{ created_by: string | null; adagents_url: string | null }>(
        `SELECT created_by, adagents_url FROM catalog_properties WHERE property_rid = $1`,
        [victimRid]
      );
      expect(victimProperty.rows[0].created_by).toBe(`adagents_json:${VICTIM_DOMAIN}`);
      expect(victimProperty.rows[0].adagents_url).toBe(
        `https://${VICTIM_DOMAIN}/.well-known/adagents.json`
      );
    });

    it('refuses to silently merge two existing properties when a manifest spans both', async () => {
      // Seed two distinct properties from a non-adagents source (community/seed),
      // each with its own identifier. A later manifest that names BOTH identifiers
      // in one property would silently merge them without this guard.
      await pool.query(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, created_by)
         VALUES
           ('11111111-1111-7111-9111-111111111111', 'alpha', 'property', 'contributed', 'active', 'test:tenant-isolation-seed'),
           ('22222222-2222-7222-9222-222222222222', 'beta',  'property', 'contributed', 'active', 'test:tenant-isolation-seed')`,
      );
      await pool.query(
        `INSERT INTO catalog_identifiers
           (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES
           (gen_random_uuid(), '11111111-1111-7111-9111-111111111111', 'ios_bundle', 'com.example.alpha', 'member_resolve', 'medium'),
           (gen_random_uuid(), '22222222-2222-7222-9222-222222222222', 'ios_bundle', 'com.example.beta',  'member_resolve', 'medium')`,
      );

      await publisherDb.upsertAdagentsCache({
        domain: TEST_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'wants_to_merge',
              property_type: 'mobile_app',
              name: 'Tries To Merge Alpha and Beta',
              identifiers: [
                { type: 'ios_bundle', value: 'com.example.alpha' },
                { type: 'ios_bundle', value: 'com.example.beta' },
              ],
            },
          ],
        },
      });

      // Both seed properties survive untouched; no third property was minted
      // for this manifest's claim.
      const seedRids = await pool.query<{ property_rid: string }>(
        `SELECT property_rid FROM catalog_identifiers
          WHERE identifier_value IN ('com.example.alpha', 'com.example.beta')
          ORDER BY identifier_value`
      );
      expect(seedRids.rows.map((r) => r.property_rid).sort()).toEqual(
        [
          '11111111-1111-7111-9111-111111111111',
          '22222222-2222-7222-9222-222222222222',
        ].sort()
      );

      const newProps = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_properties WHERE created_by = $1`,
        [`adagents_json:${TEST_DOMAIN}`]
      );
      expect(newProps.rows[0].count).toBe('0');
    });

    it('refuses cross-publisher domain claims regardless of crawl ordering (land-grab)', async () => {
      // Attacker crawls FIRST, claiming the victim's domain alongside its own
      // (attacker-first ordering — distinct from the victim-first rebind case).
      // Without the anchor rule the attacker would mint a rid pointing
      // domain:VICTIM_DOMAIN at the attacker's adagents_url, and the victim's
      // later crawl would be the one refused.
      await publisherDb.upsertAdagentsCache({
        domain: ATTACKER_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'land_grab',
              property_type: 'website',
              name: 'Land Grab Attempt',
              identifiers: [
                { type: 'domain', value: ATTACKER_DOMAIN },
                { type: 'domain', value: VICTIM_DOMAIN },
              ],
            },
          ],
        },
      });

      // Anchor rule refuses the entire property — neither identifier lands.
      const anyAttackerProp = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_properties
          WHERE created_by = $1`,
        [`adagents_json:${ATTACKER_DOMAIN}`]
      );
      expect(anyAttackerProp.rows[0].count).toBe('0');

      const victimIdentifier = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_identifiers
          WHERE identifier_type = 'domain' AND identifier_value = $1`,
        [VICTIM_DOMAIN]
      );
      expect(victimIdentifier.rows[0].count).toBe('0');

      // Victim's own crawl (which only declares its own anchored domain) lands cleanly.
      await publisherDb.upsertAdagentsCache({
        domain: VICTIM_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'victim_site',
              property_type: 'website',
              name: 'Victim Site',
              identifiers: [{ type: 'domain', value: VICTIM_DOMAIN }],
            },
          ],
        },
      });

      const victimRid = await pool.query<{ property_rid: string; created_by: string | null }>(
        `SELECT cp.property_rid, cp.created_by
           FROM catalog_identifiers ci
           JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
          WHERE ci.identifier_type = 'domain' AND ci.identifier_value = $1`,
        [VICTIM_DOMAIN]
      );
      expect(victimRid.rows).toHaveLength(1);
      expect(victimRid.rows[0].created_by).toBe(`adagents_json:${VICTIM_DOMAIN}`);
    });

    it('refuses to take over a seed-source rid without a publisher-anchored identifier', async () => {
      // Seed the catalog with a rid created by a non-adagents source (mimicking
      // migration 336 or a hosted_properties seed) — adagents_url is NULL, so
      // a COALESCE-based reuse path would happily bind the attacker's URL.
      await pool.query(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, adagents_url, created_by)
         VALUES ('33333333-3333-7333-9333-333333333333', 'seeded', 'property', 'authoritative', 'active', NULL, 'test:tenant-isolation-seed')`
      );
      await pool.query(
        `INSERT INTO catalog_identifiers
           (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES (gen_random_uuid(), '33333333-3333-7333-9333-333333333333', 'ios_bundle', 'com.example.victimapp', 'member_resolve', 'medium')`
      );

      // Attacker publishes a manifest claiming the seeded bundle ID with NO
      // anchor identifier proving they're authoritative for it. Without the
      // anchor rule the writer would reuse the seed rid and overwrite
      // adagents_url via COALESCE(NULL, attacker_url).
      await publisherDb.upsertAdagentsCache({
        domain: ATTACKER_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'unanchored_claim',
              property_type: 'mobile_app',
              name: 'Unanchored Bundle Claim',
              identifiers: [{ type: 'ios_bundle', value: 'com.example.victimapp' }],
            },
          ],
        },
      });

      // Seed rid's adagents_url is still NULL — attacker did not take over.
      const seedRow = await pool.query<{ adagents_url: string | null; created_by: string | null }>(
        `SELECT adagents_url, created_by FROM catalog_properties
          WHERE property_rid = '33333333-3333-7333-9333-333333333333'`
      );
      expect(seedRow.rows[0].adagents_url).toBeNull();
      expect(seedRow.rows[0].created_by).toBe('test:tenant-isolation-seed');
    });

    it('lets a publisher adopt a seed-source rid when the manifest carries an anchor identifier', async () => {
      // Same seed setup as above, but pre-link the publisher's own domain to
      // the seed rid (modeling migration 336's case where a discovered_property
      // had both a domain identifier and a bundle ID).
      await pool.query(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, adagents_url, created_by)
         VALUES ('44444444-4444-7444-9444-444444444444', NULL, 'property', 'authoritative', 'active', NULL, 'test:tenant-isolation-seed')`
      );
      await pool.query(
        `INSERT INTO catalog_identifiers
           (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES
           (gen_random_uuid(), '44444444-4444-7444-9444-444444444444', 'domain', $1, 'adagents_json', 'authoritative'),
           (gen_random_uuid(), '44444444-4444-7444-9444-444444444444', 'ios_bundle', 'com.example.alpha', 'member_resolve', 'medium')`,
        [VICTIM_DOMAIN]
      );

      // Legitimate publisher (matching the seeded domain) crawls, declaring
      // the same domain and the same bundle ID. The anchor proves authority,
      // so the publisher takes ownership and adagents_url is set.
      await publisherDb.upsertAdagentsCache({
        domain: VICTIM_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'adopt_seed',
              property_type: 'website',
              name: 'Adopt Seed',
              identifiers: [
                { type: 'domain', value: VICTIM_DOMAIN },
                { type: 'ios_bundle', value: 'com.example.alpha' },
              ],
            },
          ],
        },
      });

      const adopted = await pool.query<{ adagents_url: string | null; property_id: string | null }>(
        `SELECT adagents_url, property_id FROM catalog_properties
          WHERE property_rid = '44444444-4444-7444-9444-444444444444'`
      );
      expect(adopted.rows[0].adagents_url).toBe(
        `https://${VICTIM_DOMAIN}/.well-known/adagents.json`
      );
      expect(adopted.rows[0].property_id).toBe('adopt_seed');
    });

    it('does not abort the rest of the manifest when one property is refused', async () => {
      // Pre-claim an identifier from a different publisher, so when our manifest
      // tries to bind it the projection is refused for that property only. The
      // other (clean) property in the same manifest should still land.
      await publisherDb.upsertAdagentsCache({
        domain: ATTACKER_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'attacker_app',
              property_type: 'mobile_app',
              name: 'Attacker App',
              identifiers: [{ type: 'ios_bundle', value: 'com.example.victimapp' }],
            },
          ],
        },
      });

      await publisherDb.upsertAdagentsCache({
        domain: TEST_DOMAIN,
        manifest: {
          authorized_agents: [],
          properties: [
            {
              property_id: 'clean_site',
              property_type: 'website',
              name: 'Clean Site',
              identifiers: [{ type: 'domain', value: TEST_DOMAIN }],
            },
            {
              property_id: 'collides',
              property_type: 'mobile_app',
              name: 'Collides With Attacker',
              identifiers: [{ type: 'ios_bundle', value: 'com.example.victimapp' }],
            },
          ],
        },
      });

      // Clean property landed.
      const cleanProp = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_properties
          WHERE created_by = $1 AND property_id = 'clean_site'`,
        [`adagents_json:${TEST_DOMAIN}`]
      );
      expect(cleanProp.rows[0].count).toBe('1');

      // Collides property did NOT land (refused — attacker still owns the rid).
      const collidesProp = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_properties
          WHERE created_by = $1 AND property_id = 'collides'`,
        [`adagents_json:${TEST_DOMAIN}`]
      );
      expect(collidesProp.rows[0].count).toBe('0');

      // Publishers cache for the original domain still updated (the manifest
      // body cache write isn't gated on per-property success).
      const cache = await pool.query<{ source_type: string }>(
        `SELECT source_type FROM publishers WHERE domain = $1`,
        [TEST_DOMAIN]
      );
      expect(cache.rows[0].source_type).toBe('adagents_json');
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
