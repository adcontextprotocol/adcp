/**
 * Backfill correctness tests for migration 439.
 *
 * The schema-invariant tests in registry-catalog-agent-auth-schema.test.ts
 * cover the table itself; this file specifically exercises the backfill
 * logic — the part that runs once on prod data and is hard to debug after
 * the fact. Each fixture lands a legacy row, runs the backfill statements
 * against the live catalog tables, and asserts the resulting catalog row's
 * shape.
 *
 * The backfill migration ran during the DB setup, so the table is
 * already populated with whatever the test DB had when migrations
 * applied. Each test seeds new legacy rows, then re-runs the relevant
 * backfill INSERT verbatim against those new rows. ON CONFLICT keeps
 * the test idempotent.
 *
 * Refs #3177.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const TEST_PUB = 'caa-backfill.example';
const TEST_AGENT_LOWER = 'https://agent.caa-backfill.example';
const TEST_AGENT_MIXED = 'HTTPS://Agent.caa-backfill.example/';
const TEST_AGENT_CLAIM = 'https://claim-asserter.caa-backfill.example';

describe('catalog_agent_authorizations backfill (migration 439)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  async function clearTestFixtures() {
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE agent_url IN ($1, $2, $3)
           OR publisher_domain = $4`,
      [TEST_AGENT_LOWER, TEST_AGENT_MIXED, TEST_AGENT_CLAIM, TEST_PUB]
    );
    await pool.query(
      `DELETE FROM agent_property_authorizations
        WHERE agent_url IN ($1, $2, $3)`,
      [TEST_AGENT_LOWER, TEST_AGENT_MIXED, TEST_AGENT_CLAIM]
    );
    await pool.query(
      `DELETE FROM agent_publisher_authorizations
        WHERE publisher_domain = $1
           OR agent_url IN ($2, $3, $4)`,
      [TEST_PUB, TEST_AGENT_LOWER, TEST_AGENT_MIXED, TEST_AGENT_CLAIM]
    );
    await pool.query(
      `DELETE FROM discovered_properties WHERE publisher_domain = $1`,
      [TEST_PUB]
    );
    await pool.query(
      `DELETE FROM catalog_properties
        WHERE created_by = $1 OR created_by = $2`,
      [`adagents_json:${TEST_PUB}`, 'test:caa-backfill']
    );
  }

  beforeEach(async () => {
    await clearTestFixtures();
  });

  afterAll(async () => {
    await clearTestFixtures();
    await closeDatabase();
  });

  // ──────────────────────────────────────────────────────────────────
  // Helpers — re-execute each backfill INSERT verbatim against new
  // fixtures so we test the actual SQL, not a paraphrase.
  // ──────────────────────────────────────────────────────────────────

  async function runArm1(): Promise<void> {
    await pool.query(`
      INSERT INTO catalog_agent_authorizations (
        id, agent_url, agent_url_canonical, property_rid, property_id_slug,
        publisher_domain, authorized_for, evidence, created_by,
        created_at, updated_at
      )
      SELECT
        gen_random_uuid(),
        apa.agent_url,
        CASE WHEN apa.agent_url = '*'
             THEN '*'
             ELSE rtrim(lower(apa.agent_url), '/')
        END,
        cp.property_rid,
        dp.property_id,
        NULL,
        apa.authorized_for,
        'adagents_json',
        'system',
        apa.discovered_at,
        apa.discovered_at
      FROM agent_property_authorizations apa
      JOIN discovered_properties dp ON dp.id = apa.property_id
      JOIN catalog_properties    cp ON cp.property_rid = dp.id
      ON CONFLICT (agent_url_canonical,
                   (COALESCE(property_rid::text, '')),
                   (COALESCE(publisher_domain, '')),
                   evidence)
      WHERE deleted_at IS NULL
      DO NOTHING;
    `);
  }

  async function runArm2(): Promise<void> {
    await pool.query(`
      INSERT INTO catalog_agent_authorizations (
        id, agent_url, agent_url_canonical, property_rid, property_id_slug,
        publisher_domain, authorized_for, evidence, created_by,
        created_at, updated_at
      )
      SELECT
        gen_random_uuid(),
        apa.agent_url,
        CASE WHEN apa.agent_url = '*'
             THEN '*'
             ELSE rtrim(lower(apa.agent_url), '/')
        END,
        NULL,
        NULL,
        apa.publisher_domain,
        apa.authorized_for,
        apa.source,
        CASE WHEN apa.source = 'agent_claim'
             THEN apa.agent_url
             ELSE 'system'
        END,
        apa.discovered_at,
        COALESCE(apa.last_validated, apa.discovered_at)
      FROM agent_publisher_authorizations apa
      WHERE apa.property_ids IS NULL
         OR array_length(apa.property_ids, 1) IS NULL
      ON CONFLICT (agent_url_canonical,
                   (COALESCE(property_rid::text, '')),
                   (COALESCE(publisher_domain, '')),
                   evidence)
      WHERE deleted_at IS NULL
      DO NOTHING;
    `);
  }

  async function runArm3(): Promise<void> {
    await pool.query(`
      INSERT INTO catalog_agent_authorizations (
        id, agent_url, agent_url_canonical, property_rid, property_id_slug,
        publisher_domain, authorized_for, evidence, created_by,
        created_at, updated_at
      )
      SELECT
        gen_random_uuid(),
        apa.agent_url,
        CASE WHEN apa.agent_url = '*'
             THEN '*'
             ELSE rtrim(lower(apa.agent_url), '/')
        END,
        cp.property_rid,
        slug,
        NULL,
        apa.authorized_for,
        apa.source,
        CASE WHEN apa.source = 'agent_claim'
             THEN apa.agent_url
             ELSE 'system'
        END,
        apa.discovered_at,
        COALESCE(apa.last_validated, apa.discovered_at)
      FROM agent_publisher_authorizations apa
      CROSS JOIN LATERAL unnest(apa.property_ids) AS slug
      JOIN catalog_properties cp
        ON cp.property_id = slug
       AND cp.created_by   = 'adagents_json:' || apa.publisher_domain
      WHERE apa.property_ids IS NOT NULL
        AND array_length(apa.property_ids, 1) IS NOT NULL
      ON CONFLICT (agent_url_canonical,
                   (COALESCE(property_rid::text, '')),
                   (COALESCE(publisher_domain, '')),
                   evidence)
      WHERE deleted_at IS NULL
      DO NOTHING;
    `);
  }

  async function seedCatalogProperty(slug: string): Promise<string> {
    const result = await pool.query<{ property_rid: string }>(
      `INSERT INTO catalog_properties
         (property_rid, property_id, classification, source, status, created_by)
       VALUES (gen_random_uuid(), $1, 'property', 'authoritative', 'active', $2)
       RETURNING property_rid`,
      [slug, `adagents_json:${TEST_PUB}`]
    );
    return result.rows[0].property_rid;
  }

  async function seedDiscoveredProperty(rid: string, slug: string): Promise<void> {
    // Pre-seed match: discovered_properties.id == catalog_properties.property_rid.
    await pool.query(
      `INSERT INTO discovered_properties
         (id, property_id, publisher_domain, property_type, name, identifiers)
       VALUES ($1, $2, $3, 'website', $2, '[]'::jsonb)`,
      [rid, slug, TEST_PUB]
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Arm 1 — agent_property_authorizations → per-property catalog rows
  // ──────────────────────────────────────────────────────────────────

  describe('arm 1: per-property from agent_property_authorizations', () => {
    it('canonicalizes mixed-case + trailing-slash agent_url', async () => {
      const rid = await seedCatalogProperty('home');
      await seedDiscoveredProperty(rid, 'home');
      await pool.query(
        `INSERT INTO agent_property_authorizations
           (agent_url, property_id, authorized_for)
         VALUES ($1, $2, 'display')`,
        [TEST_AGENT_MIXED, rid]
      );

      await runArm1();

      const { rows } = await pool.query<{
        agent_url: string;
        agent_url_canonical: string;
        property_rid: string;
        property_id_slug: string;
        publisher_domain: string | null;
        evidence: string;
        created_by: string;
      }>(
        `SELECT agent_url, agent_url_canonical, property_rid, property_id_slug,
                publisher_domain, evidence, created_by
           FROM catalog_agent_authorizations
          WHERE property_rid = $1`,
        [rid]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_url).toBe(TEST_AGENT_MIXED);
      expect(rows[0].agent_url_canonical).toBe(TEST_AGENT_LOWER);
      expect(rows[0].property_id_slug).toBe('home');
      expect(rows[0].publisher_domain).toBeNull();
      expect(rows[0].evidence).toBe('adagents_json');
      expect(rows[0].created_by).toBe('system');
    });

    it('skips post-seed rows where property_id does not resolve to a catalog_properties row', async () => {
      // Seed a discovered_property without a catalog_properties counterpart
      // (the post-seed-divergence case).
      const orphanId = '00000000-0000-7000-9000-000000000001';
      await pool.query(
        `INSERT INTO discovered_properties
           (id, property_id, publisher_domain, property_type, name, identifiers)
         VALUES ($1, 'orphan', $2, 'website', 'orphan', '[]'::jsonb)`,
        [orphanId, TEST_PUB]
      );
      await pool.query(
        `INSERT INTO agent_property_authorizations
           (agent_url, property_id, authorized_for)
         VALUES ($1, $2, 'display')`,
        [TEST_AGENT_LOWER, orphanId]
      );

      await runArm1();

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1`,
        [TEST_AGENT_LOWER]
      );
      expect(rows[0].count).toBe('0');
    });

    it('is idempotent on re-run', async () => {
      const rid = await seedCatalogProperty('home');
      await seedDiscoveredProperty(rid, 'home');
      await pool.query(
        `INSERT INTO agent_property_authorizations
           (agent_url, property_id, authorized_for)
         VALUES ($1, $2, 'display')`,
        [TEST_AGENT_LOWER, rid]
      );

      await runArm1();
      await runArm1();
      await runArm1();

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_agent_authorizations
          WHERE property_rid = $1`,
        [rid]
      );
      expect(rows[0].count).toBe('1');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Arm 2 — agent_publisher_authorizations (NULL property_ids)
  // ──────────────────────────────────────────────────────────────────

  describe('arm 2: publisher-wide from agent_publisher_authorizations', () => {
    it('publishes adagents_json source as a publisher-wide row with created_by=system', async () => {
      await pool.query(
        `INSERT INTO agent_publisher_authorizations
           (agent_url, publisher_domain, source)
         VALUES ($1, $2, 'adagents_json')`,
        [TEST_AGENT_LOWER, TEST_PUB]
      );
      await runArm2();
      const { rows } = await pool.query<{
        property_rid: string | null;
        publisher_domain: string;
        evidence: string;
        created_by: string;
      }>(
        `SELECT property_rid, publisher_domain, evidence, created_by
           FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT_LOWER, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].property_rid).toBeNull();
      expect(rows[0].evidence).toBe('adagents_json');
      expect(rows[0].created_by).toBe('system');
    });

    it('agent_claim source carries the asserting agent in created_by', async () => {
      await pool.query(
        `INSERT INTO agent_publisher_authorizations
           (agent_url, publisher_domain, source)
         VALUES ($1, $2, 'agent_claim')`,
        [TEST_AGENT_CLAIM, TEST_PUB]
      );
      await runArm2();
      const { rows } = await pool.query<{ evidence: string; created_by: string }>(
        `SELECT evidence, created_by FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT_CLAIM, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].evidence).toBe('agent_claim');
      expect(rows[0].created_by).toBe(TEST_AGENT_CLAIM);
    });

    it('canonicalizes mixed-case agent_url for publisher-wide rows', async () => {
      await pool.query(
        `INSERT INTO agent_publisher_authorizations
           (agent_url, publisher_domain, source)
         VALUES ($1, $2, 'adagents_json')`,
        [TEST_AGENT_MIXED, TEST_PUB]
      );
      await runArm2();
      const { rows } = await pool.query<{ agent_url_canonical: string }>(
        `SELECT agent_url_canonical FROM catalog_agent_authorizations
          WHERE publisher_domain = $1`,
        [TEST_PUB]
      );
      expect(rows[0].agent_url_canonical).toBe(TEST_AGENT_LOWER);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Arm 3 — agent_publisher_authorizations.property_ids[] fan-out
  // ──────────────────────────────────────────────────────────────────

  describe('arm 3: per-property fan-out from publisher.property_ids[]', () => {
    it('fans out one catalog row per resolved slug; unresolved slugs skipped', async () => {
      const ridHome = await seedCatalogProperty('home');
      const ridNews = await seedCatalogProperty('news');
      await pool.query(
        `INSERT INTO agent_publisher_authorizations
           (agent_url, publisher_domain, source, property_ids)
         VALUES ($1, $2, 'adagents_json', ARRAY['home', 'news', 'unknown_slug'])`,
        [TEST_AGENT_LOWER, TEST_PUB]
      );

      await runArm3();

      const { rows } = await pool.query<{ property_id_slug: string; property_rid: string }>(
        `SELECT property_id_slug, property_rid FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1
          ORDER BY property_id_slug`,
        [TEST_AGENT_LOWER]
      );
      expect(rows.map((r) => r.property_id_slug)).toEqual(['home', 'news']);
      const ridsBySlug = new Map(rows.map((r) => [r.property_id_slug, r.property_rid]));
      expect(ridsBySlug.get('home')).toBe(ridHome);
      expect(ridsBySlug.get('news')).toBe(ridNews);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Pre-flight assertion — fail loudly on unknown legacy source
  // ──────────────────────────────────────────────────────────────────

  describe('source-value pre-flight (assertion in migration 439)', () => {
    it('rejects an unknown source value via the schema CHECK on evidence', async () => {
      // The migration's pre-flight assertion would have aborted at
      // backfill time. After the migration, the schema's evidence
      // CHECK enforces the same invariant on any further INSERT.
      await pool.query(
        `INSERT INTO agent_publisher_authorizations
           (agent_url, publisher_domain, source)
         VALUES ($1, $2, 'fictitious_source')`,
        [TEST_AGENT_LOWER, TEST_PUB]
      );
      // Run arm 2 and expect it to fail because the evidence CHECK rejects.
      await expect(runArm2()).rejects.toThrow(/evidence/);
    });
  });
});
