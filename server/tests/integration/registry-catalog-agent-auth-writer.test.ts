/**
 * Writer-side integration tests for catalog_agent_authorizations
 * projection (PR 4b of #3177).
 *
 * cacheAdagentsManifest projects the manifest's authorized_agents[]
 * entries into catalog_agent_authorizations after the property-side
 * projection runs. Coverage focuses on the four projection variants
 * the writer supports (property_ids, inline_properties,
 * publisher_properties, publisher-wide) plus the security guards
 * (cross-publisher refusal, embedded-wildcard rejection,
 * canonicalization).
 *
 * Variants explicitly NOT covered by v1: property_tags, signal_ids,
 * signal_tags. The writer logs and skips those; they continue to be
 * served by the legacy agent_publisher_authorizations table via the
 * UNION reader during the dual-read window.
 *
 * Refs #3177. Builds on #3274 (schema). Spec #3251.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase, type AdagentsManifest } from '../../src/db/publisher-db.js';

const TEST_PUB = 'caa-writer.example';
const VICTIM_PUB = 'caa-writer-victim.example';
const TEST_AGENT_RAW = 'HTTPS://Agent.caa-writer.example/';
const TEST_AGENT_CANON = 'https://agent.caa-writer.example';
const OTHER_AGENT = 'https://other.caa-writer.example';

describe('catalog_agent_authorizations writer projection', () => {
  let pool: Pool;
  let publisherDb: PublisherDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    publisherDb = new PublisherDatabase();
  });

  async function clearTestFixtures() {
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE agent_url_canonical IN ($1, $2, '*')
           OR publisher_domain IN ($3, $4)`,
      [TEST_AGENT_CANON, OTHER_AGENT, TEST_PUB, VICTIM_PUB]
    );
    await pool.query(
      `DELETE FROM catalog_identifiers
        WHERE property_rid IN (
          SELECT property_rid FROM catalog_properties
            WHERE created_by IN ($1, $2)
        )`,
      [`adagents_json:${TEST_PUB}`, `adagents_json:${VICTIM_PUB}`]
    );
    await pool.query(
      `DELETE FROM catalog_properties WHERE created_by IN ($1, $2)`,
      [`adagents_json:${TEST_PUB}`, `adagents_json:${VICTIM_PUB}`]
    );
    await pool.query(
      `DELETE FROM publishers WHERE domain IN ($1, $2)`,
      [TEST_PUB, VICTIM_PUB]
    );
  }

  beforeEach(async () => {
    await clearTestFixtures();
  });

  afterAll(async () => {
    await clearTestFixtures();
    await closeDatabase();
  });

  function manifest(authorized_agents: AdagentsManifest['authorized_agents'], properties: AdagentsManifest['properties'] = []): AdagentsManifest {
    return { authorized_agents, properties };
  }

  // ──────────────────────────────────────────────────────────────────
  // Variant: no authorization_type → publisher-wide
  // ──────────────────────────────────────────────────────────────────

  describe('publisher-wide auth (no authorization_type)', () => {
    it('projects one CAA row with property_rid IS NULL', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([{ url: TEST_AGENT_RAW, authorized_for: 'display' }]),
      });

      const { rows } = await pool.query<{
        agent_url: string;
        agent_url_canonical: string;
        property_rid: string | null;
        publisher_domain: string | null;
        authorized_for: string | null;
        evidence: string;
        created_by: string;
      }>(
        `SELECT agent_url, agent_url_canonical, property_rid, publisher_domain,
                authorized_for, evidence, created_by
           FROM catalog_agent_authorizations
          WHERE publisher_domain = $1`,
        [TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_url).toBe(TEST_AGENT_RAW.trim());
      expect(rows[0].agent_url_canonical).toBe(TEST_AGENT_CANON);
      expect(rows[0].property_rid).toBeNull();
      expect(rows[0].publisher_domain).toBe(TEST_PUB);
      expect(rows[0].authorized_for).toBe('display');
      expect(rows[0].evidence).toBe('adagents_json');
      expect(rows[0].created_by).toBe('system');
    });

    it('skips entries with missing/empty url', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([{ authorized_for: 'display' } as never]),
      });
      const { rows } = await pool.query(
        `SELECT 1 FROM catalog_agent_authorizations WHERE publisher_domain = $1`,
        [TEST_PUB]
      );
      expect(rows).toHaveLength(0);
    });

    it('rejects embedded wildcards in agent_url', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([{ url: '*foo*' }, { url: '*.example.com' }]),
      });
      const { rows } = await pool.query(
        `SELECT 1 FROM catalog_agent_authorizations WHERE publisher_domain = $1`,
        [TEST_PUB]
      );
      expect(rows).toHaveLength(0);
    });

    it('accepts the wildcard sentinel exactly (*)', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([{ url: '*' }]),
      });
      const { rows } = await pool.query<{ agent_url_canonical: string }>(
        `SELECT agent_url_canonical FROM catalog_agent_authorizations
          WHERE publisher_domain = $1`,
        [TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_url_canonical).toBe('*');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variant: property_ids
  // ──────────────────────────────────────────────────────────────────

  describe('property_ids variant', () => {
    it('projects one CAA row per resolved property_rid', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest(
          [
            {
              url: TEST_AGENT_RAW,
              authorization_type: 'property_ids',
              property_ids: ['site_a', 'site_b'],
            },
          ],
          [
            {
              property_id: 'site_a',
              property_type: 'website',
              name: 'Site A',
              identifiers: [{ type: 'domain', value: TEST_PUB }],
            },
            {
              property_id: 'site_b',
              property_type: 'website',
              name: 'Site B',
              identifiers: [{ type: 'subdomain', value: `news.${TEST_PUB}` }],
            },
          ]
        ),
      });

      const { rows } = await pool.query<{
        agent_url_canonical: string;
        property_id_slug: string | null;
        publisher_domain: string | null;
      }>(
        `SELECT caa.agent_url_canonical, caa.property_id_slug, caa.publisher_domain
           FROM catalog_agent_authorizations caa
           JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
          WHERE cp.created_by = $1
          ORDER BY caa.property_id_slug`,
        [`adagents_json:${TEST_PUB}`]
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.property_id_slug)).toEqual(['site_a', 'site_b']);
      for (const r of rows) {
        expect(r.agent_url_canonical).toBe(TEST_AGENT_CANON);
        expect(r.publisher_domain).toBeNull();
      }
    });

    it('skips slugs that do not resolve to a catalog_properties row', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest(
          [
            {
              url: TEST_AGENT_RAW,
              authorization_type: 'property_ids',
              property_ids: ['known', 'unresolved'],
            },
          ],
          [
            {
              property_id: 'known',
              property_type: 'website',
              name: 'Known',
              identifiers: [{ type: 'domain', value: TEST_PUB }],
            },
          ]
        ),
      });
      const { rows } = await pool.query<{ property_id_slug: string }>(
        `SELECT property_id_slug FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1
            AND property_rid IS NOT NULL`,
        [TEST_AGENT_CANON]
      );
      expect(rows.map((r) => r.property_id_slug)).toEqual(['known']);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variant: inline_properties
  // ──────────────────────────────────────────────────────────────────

  describe('inline_properties variant', () => {
    it('projects inline properties to catalog AND inserts auth rows referencing them', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([
          {
            url: TEST_AGENT_RAW,
            authorization_type: 'inline_properties',
            properties: [
              {
                property_id: 'inline_a',
                property_type: 'website',
                name: 'Inline A',
                identifiers: [{ type: 'domain', value: TEST_PUB }],
              },
            ],
          },
        ]),
      });

      const propResult = await pool.query<{ property_rid: string }>(
        `SELECT property_rid FROM catalog_properties
          WHERE created_by = $1 AND property_id = 'inline_a'`,
        [`adagents_json:${TEST_PUB}`]
      );
      expect(propResult.rows).toHaveLength(1);
      const rid = propResult.rows[0].property_rid;

      const { rows } = await pool.query<{ property_rid: string; property_id_slug: string }>(
        `SELECT property_rid, property_id_slug FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1`,
        [TEST_AGENT_CANON]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].property_rid).toBe(rid);
      expect(rows[0].property_id_slug).toBe('inline_a');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variant: publisher_properties (anchor case + cross-publisher refusal)
  // ──────────────────────────────────────────────────────────────────

  describe('publisher_properties variant', () => {
    it('selection_type=all over the publisher\'s own properties resolves into N rows', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest(
          [
            {
              url: TEST_AGENT_RAW,
              authorization_type: 'publisher_properties',
              publisher_properties: [
                { publisher_domain: TEST_PUB, selection_type: 'all' },
              ],
            },
          ],
          [
            {
              property_id: 'site_a',
              property_type: 'website',
              name: 'Site A',
              identifiers: [{ type: 'domain', value: TEST_PUB }],
            },
            {
              property_id: 'site_b',
              property_type: 'website',
              name: 'Site B',
              identifiers: [{ type: 'subdomain', value: `b.${TEST_PUB}` }],
            },
          ]
        ),
      });

      const { rows } = await pool.query<{ property_id_slug: string }>(
        `SELECT property_id_slug FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND property_rid IS NOT NULL
          ORDER BY property_id_slug`,
        [TEST_AGENT_CANON]
      );
      expect(rows.map((r) => r.property_id_slug)).toEqual(['site_a', 'site_b']);
    });

    it('selection_type=by_id resolves only the named slugs', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest(
          [
            {
              url: TEST_AGENT_RAW,
              authorization_type: 'publisher_properties',
              publisher_properties: [
                { publisher_domain: TEST_PUB, selection_type: 'by_id', property_ids: ['site_a'] },
              ],
            },
          ],
          [
            {
              property_id: 'site_a',
              property_type: 'website',
              name: 'Site A',
              identifiers: [{ type: 'domain', value: TEST_PUB }],
            },
            {
              property_id: 'site_b',
              property_type: 'website',
              name: 'Site B',
              identifiers: [{ type: 'subdomain', value: `b.${TEST_PUB}` }],
            },
          ]
        ),
      });
      const { rows } = await pool.query<{ property_id_slug: string }>(
        `SELECT property_id_slug FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND property_rid IS NOT NULL`,
        [TEST_AGENT_CANON]
      );
      expect(rows.map((r) => r.property_id_slug)).toEqual(['site_a']);
    });

    it('refuses cross-publisher publisher_properties claims', async () => {
      // Pre-seed a catalog property under VICTIM_PUB so the lookup *would*
      // resolve if the writer didn't refuse.
      await publisherDb.upsertAdagentsCache({
        domain: VICTIM_PUB,
        manifest: manifest(
          [],
          [
            {
              property_id: 'home',
              property_type: 'website',
              name: 'Victim home',
              identifiers: [{ type: 'domain', value: VICTIM_PUB }],
            },
          ]
        ),
      });
      // Attacker (TEST_PUB) tries to claim VICTIM_PUB's property.
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([
          {
            url: TEST_AGENT_RAW,
            authorization_type: 'publisher_properties',
            publisher_properties: [
              { publisher_domain: VICTIM_PUB, selection_type: 'by_id', property_ids: ['home'] },
            ],
          },
        ]),
      });
      const { rows } = await pool.query(
        `SELECT 1 FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND property_rid IS NOT NULL`,
        [TEST_AGENT_CANON]
      );
      expect(rows).toHaveLength(0);
    });

    it('skips selection_type=by_tag (deferred per spec)', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest(
          [
            {
              url: TEST_AGENT_RAW,
              authorization_type: 'publisher_properties',
              publisher_properties: [
                { publisher_domain: TEST_PUB, selection_type: 'by_tag', property_tags: ['flagship'] },
              ],
            },
          ],
          [
            {
              property_id: 'site_a',
              property_type: 'website',
              name: 'Site A',
              identifiers: [{ type: 'domain', value: TEST_PUB }],
              tags: ['flagship'],
            },
          ]
        ),
      });
      const { rows } = await pool.query(
        `SELECT 1 FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1`,
        [TEST_AGENT_CANON]
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Deferred variants — no rows projected, no errors
  // ──────────────────────────────────────────────────────────────────

  describe('deferred variants', () => {
    it.each(['property_tags', 'signal_ids', 'signal_tags'] as const)(
      'authorization_type=%s emits no CAA rows',
      async (variant) => {
        await publisherDb.upsertAdagentsCache({
          domain: TEST_PUB,
          manifest: manifest([
            {
              url: TEST_AGENT_RAW,
              authorization_type: variant,
              property_ids: ['x'],
            },
          ]),
        });
        const { rows } = await pool.query(
          `SELECT 1 FROM catalog_agent_authorizations WHERE agent_url_canonical = $1`,
          [TEST_AGENT_CANON]
        );
        expect(rows).toHaveLength(0);
      }
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Re-crawl idempotency
  // ──────────────────────────────────────────────────────────────────

  describe('re-crawl idempotency', () => {
    it('re-crawling the same manifest does not duplicate rows', async () => {
      const m: AdagentsManifest = manifest([
        { url: TEST_AGENT_RAW, authorized_for: 'display' },
      ]);
      await publisherDb.upsertAdagentsCache({ domain: TEST_PUB, manifest: m });
      await publisherDb.upsertAdagentsCache({ domain: TEST_PUB, manifest: m });
      const { rows } = await pool.query(
        `SELECT 1 FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2 AND deleted_at IS NULL`,
        [TEST_AGENT_CANON, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
    });

    it('re-crawl with a changed authorized_for updates the existing row', async () => {
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([{ url: TEST_AGENT_RAW, authorized_for: 'display' }]),
      });
      await publisherDb.upsertAdagentsCache({
        domain: TEST_PUB,
        manifest: manifest([{ url: TEST_AGENT_RAW, authorized_for: 'video' }]),
      });
      const { rows } = await pool.query<{ authorized_for: string }>(
        `SELECT authorized_for FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2 AND deleted_at IS NULL`,
        [TEST_AGENT_CANON, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].authorized_for).toBe('video');
    });
  });
});
