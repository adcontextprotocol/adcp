/**
 * Smoke tests for migration 438_catalog_agent_authorizations.
 *
 * Asserts the schema invariants the spec
 * (specs/registry-authorization-model.md) commits to are actually
 * enforced by the database — not just documented in comments. The
 * CHECK constraints, partial unique index, soft-delete trigger, and
 * override view's UNION ALL semantics are load-bearing for tenant
 * isolation and sync correctness, and a typo'd constraint or
 * miswired view would degrade silently.
 *
 * Tests-only — no production code touched.
 *
 * Refs #3177. Gates PR 4b.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const TEST_PUB = 'caa-schema.example';
const TEST_AGENT = 'https://agent.caa-schema.example';
const TEST_AGENT_OTHER = 'https://other-agent.caa-schema.example';

describe('438_catalog_agent_authorizations schema', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  // Scope cleanup to this file's fixtures.
  async function clearTestFixtures() {
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE agent_url_canonical IN ($1, $2)
           OR publisher_domain = $3`,
      [TEST_AGENT, TEST_AGENT_OTHER, TEST_PUB]
    );
    await pool.query(
      `DELETE FROM adagents_authorization_overrides WHERE host_domain = $1`,
      [TEST_PUB]
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
  // Schema shape
  // ──────────────────────────────────────────────────────────────────

  describe('table shape', () => {
    it('catalog_agent_authorizations exists with the expected columns', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'catalog_agent_authorizations'
          ORDER BY column_name`
      );
      const columns = new Set(rows.map((r) => r.column_name));
      const expected = [
        'id', 'seq_no',
        'agent_url', 'agent_url_canonical',
        'property_rid', 'publisher_domain', 'property_id_slug',
        'authorized_for', 'evidence', 'disputed',
        'created_by', 'expires_at',
        'created_at', 'updated_at', 'deleted_at',
      ];
      for (const col of expected) {
        expect(columns).toContain(col);
      }
    });

    it('seq_no has a UNIQUE backing index', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'catalog_agent_authorizations'
            AND indexdef LIKE '%seq_no%'
            AND indexdef LIKE '%UNIQUE%'`
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('all expected named indexes are present', async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'catalog_agent_authorizations'`
      );
      const names = new Set(rows.map((r) => r.indexname));
      const expected = [
        'idx_caa_unique_active',
        'idx_caa_by_agent',
        'idx_caa_by_publisher',
        'idx_caa_by_property',
        'idx_caa_override_join',
        'idx_caa_seq',
        'idx_caa_expires',
        'idx_caa_tombstone_ttl',
      ];
      for (const idx of expected) {
        expect(names).toContain(idx);
      }
    });

    it('idx_caa_unique_active is a partial unique index keyed on (agent, scope, evidence)', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_caa_unique_active'`
      );
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toMatch(/UNIQUE/i);
      expect(def).toMatch(/agent_url_canonical/);
      expect(def).toMatch(/COALESCE\(\(property_rid\)::text/i);
      expect(def).toMatch(/COALESCE\(publisher_domain/i);
      expect(def).toMatch(/evidence/);
      expect(def).toMatch(/WHERE.*deleted_at IS NULL/i);
    });

    it('idx_caa_seq is NOT partial (tombstones must be visible to delta consumers)', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_caa_seq'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).not.toMatch(/WHERE/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // CHECK constraints
  // ──────────────────────────────────────────────────────────────────

  describe('CHECK constraints', () => {
    it('rejects non-canonical agent_url_canonical (uppercase)', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence)
           VALUES ($1, $2, $3, 'adagents_json')`,
          [TEST_AGENT, 'HTTPS://Agent.caa-schema.example', TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_agent_url_canonical/);
    });

    it('rejects non-canonical agent_url_canonical (trailing slash)', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence)
           VALUES ($1, $2, $3, 'adagents_json')`,
          [TEST_AGENT, `${TEST_AGENT}/`, TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_agent_url_canonical/);
    });

    it('rejects embedded wildcards (e.g. *foo*) — only exact * is the sentinel', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence)
           VALUES ($1, '*foo*', $2, 'adagents_json')`,
          [TEST_AGENT, TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_agent_url_canonical/);
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence)
           VALUES ($1, '*.example.com', $2, 'adagents_json')`,
          [TEST_AGENT, TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_agent_url_canonical/);
    });

    it('accepts the wildcard sentinel (*)', async () => {
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ('*', '*', $1, 'adagents_json')`,
        [TEST_PUB]
      );
      const { rows } = await pool.query(
        `SELECT 1 FROM catalog_agent_authorizations
          WHERE agent_url_canonical = '*' AND publisher_domain = $1`,
        [TEST_PUB]
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects rows with both property_rid and publisher_domain set', async () => {
      // Need a real property_rid; create one.
      const propResult = await pool.query<{ property_rid: string }>(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, created_by)
         VALUES (gen_random_uuid(), 'p1', 'property', 'authoritative', 'active', 'test:caa-schema')
         RETURNING property_rid`
      );
      const rid = propResult.rows[0].property_rid;
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, property_rid, publisher_domain, evidence)
           VALUES ($1, $1, $2, $3, 'adagents_json')`,
          [TEST_AGENT, rid, TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_publisher_domain_scope/);
      // Cleanup the property.
      await pool.query(`DELETE FROM catalog_properties WHERE property_rid = $1`, [rid]);
    });

    it('rejects rows with neither property_rid nor publisher_domain set', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, evidence)
           VALUES ($1, $1, 'adagents_json')`,
          [TEST_AGENT]
        )
      ).rejects.toThrow(/chk_caa_publisher_domain_scope/);
    });

    it('rejects expires_at on non-claim rows', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence, expires_at)
           VALUES ($1, $1, $2, 'adagents_json', NOW() + interval '1 day')`,
          [TEST_AGENT, TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_expires_only_for_claims/);
    });

    it('accepts expires_at on agent_claim rows', async () => {
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, expires_at, created_by)
         VALUES ($1, $1, $2, 'agent_claim', NOW() + interval '1 day', $1)`,
        [TEST_AGENT, TEST_PUB]
      );
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND evidence = 'agent_claim'`,
        [TEST_AGENT]
      );
      expect(rows[0].count).toBe('1');
    });

    it('rejects unknown evidence values', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence)
           VALUES ($1, $1, $2, 'made_up_source')`,
          [TEST_AGENT, TEST_PUB]
        )
      ).rejects.toThrow(/evidence/);
    });

    it('rejects agent_claim row with NULL created_by (revocation invariant)', async () => {
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence, created_by)
           VALUES ($1, $1, $2, 'agent_claim', NULL)`,
          [TEST_AGENT, TEST_PUB]
        )
      ).rejects.toThrow(/chk_caa_claim_has_created_by/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Active-set unique index
  // ──────────────────────────────────────────────────────────────────

  describe('active-set unique index', () => {
    it('blocks duplicate (agent, scope, evidence) rows when both are live', async () => {
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')`,
        [TEST_AGENT, TEST_PUB]
      );
      await expect(
        pool.query(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence)
           VALUES ($1, $1, $2, 'adagents_json')`,
          [TEST_AGENT, TEST_PUB]
        )
      ).rejects.toThrow(/idx_caa_unique_active/);
    });

    it('allows tombstoned rows to coexist with a live row of the same key', async () => {
      const live = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );
      // Tombstone the first row.
      await pool.query(
        `UPDATE catalog_agent_authorizations SET deleted_at = NOW() WHERE id = $1`,
        [live.rows[0].id]
      );
      // Now a fresh live row with the same (agent, scope, evidence) inserts cleanly.
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')`,
        [TEST_AGENT, TEST_PUB]
      );
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows[0].count).toBe('2');
    });

    it('treats different evidence values for the same (agent, scope) as distinct rows', async () => {
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')`,
        [TEST_AGENT, TEST_PUB]
      );
      // Same agent + scope but different evidence — the legacy schema allowed
      // both (UNIQUE included source); the new schema preserves that.
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, created_by)
         VALUES ($1, $1, $2, 'agent_claim', $1)`,
        [TEST_AGENT, TEST_PUB]
      );
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows[0].count).toBe('2');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // seq_no rotation trigger
  // ──────────────────────────────────────────────────────────────────

  describe('seq_no rotation trigger', () => {
    it('rotates seq_no when deleted_at transitions from NULL to NOT NULL', async () => {
      const inserted = await pool.query<{ id: string; seq_no: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')
         RETURNING id, seq_no`,
        [TEST_AGENT, TEST_PUB]
      );
      const initialSeqNo = inserted.rows[0].seq_no;

      // Soft-delete: trigger rotates seq_no.
      const after = await pool.query<{ seq_no: string }>(
        `UPDATE catalog_agent_authorizations SET deleted_at = NOW() WHERE id = $1
         RETURNING seq_no`,
        [inserted.rows[0].id]
      );
      expect(after.rows[0].seq_no).not.toBe(initialSeqNo);
      expect(BigInt(after.rows[0].seq_no)).toBeGreaterThan(BigInt(initialSeqNo));
    });

    it('does NOT rotate seq_no on UPDATE that doesn\'t change deleted_at', async () => {
      const inserted = await pool.query<{ id: string; seq_no: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, authorized_for)
         VALUES ($1, $1, $2, 'adagents_json', 'original')
         RETURNING id, seq_no`,
        [TEST_AGENT, TEST_PUB]
      );
      const initialSeqNo = inserted.rows[0].seq_no;
      const after = await pool.query<{ seq_no: string }>(
        `UPDATE catalog_agent_authorizations SET authorized_for = 'modified' WHERE id = $1
         RETURNING seq_no`,
        [inserted.rows[0].id]
      );
      expect(after.rows[0].seq_no).toBe(initialSeqNo);
    });

    it('rotates seq_no when un-tombstoning (deleted_at NOT NULL → NULL)', async () => {
      // Resurrection has the same delta-sync hazard as tombstoning: a row
      // that re-enters the active set with a stale seq_no is invisible to
      // every consumer whose cursor is past it. Trigger rotates on both
      // transitions.
      const inserted = await pool.query<{ id: string; seq_no: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, deleted_at)
         VALUES ($1, $1, $2, 'adagents_json', NOW())
         RETURNING id, seq_no`,
        [TEST_AGENT, TEST_PUB]
      );
      const tombstoneSeqNo = inserted.rows[0].seq_no;
      const after = await pool.query<{ seq_no: string }>(
        `UPDATE catalog_agent_authorizations SET deleted_at = NULL WHERE id = $1
         RETURNING seq_no`,
        [inserted.rows[0].id]
      );
      expect(after.rows[0].seq_no).not.toBe(tombstoneSeqNo);
      expect(BigInt(after.rows[0].seq_no)).toBeGreaterThan(BigInt(tombstoneSeqNo));
    });

    it('does NOT rotate seq_no on idempotent re-tombstone (NOT NULL → NOT NULL)', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, deleted_at)
         VALUES ($1, $1, $2, 'adagents_json', NOW())
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );
      const beforeSeq = await pool.query<{ seq_no: string }>(
        `SELECT seq_no FROM catalog_agent_authorizations WHERE id = $1`,
        [inserted.rows[0].id]
      );
      const after = await pool.query<{ seq_no: string }>(
        `UPDATE catalog_agent_authorizations SET deleted_at = NOW() + interval '1 hour' WHERE id = $1
         RETURNING seq_no`,
        [inserted.rows[0].id]
      );
      expect(after.rows[0].seq_no).toBe(beforeSeq.rows[0].seq_no);
    });

    it('rotates seq_no on ON CONFLICT DO UPDATE that flips deleted_at', async () => {
      // Upsert paths fire BEFORE UPDATE triggers — the trigger must see
      // the deleted_at flip there too, not just on plain UPDATE.
      const first = await pool.query<{ id: string; seq_no: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')
         RETURNING id, seq_no`,
        [TEST_AGENT, TEST_PUB]
      );
      const initialSeqNo = first.rows[0].seq_no;

      const second = await pool.query<{ id: string; seq_no: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')
         ON CONFLICT (agent_url_canonical,
                      (COALESCE(property_rid::text, '')),
                      (COALESCE(publisher_domain, '')),
                      evidence)
                WHERE deleted_at IS NULL
         DO UPDATE SET deleted_at = NOW()
         RETURNING id, seq_no`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(second.rows[0].id).toBe(first.rows[0].id);
      expect(second.rows[0].seq_no).not.toBe(initialSeqNo);
      expect(BigInt(second.rows[0].seq_no)).toBeGreaterThan(BigInt(initialSeqNo));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // v_effective_agent_authorizations
  // ──────────────────────────────────────────────────────────────────

  describe('v_effective_agent_authorizations', () => {
    it('exists as a view', async () => {
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
          WHERE table_name = 'v_effective_agent_authorizations'`
      );
      expect(rows).toHaveLength(1);
    });

    async function seedBaseRow(evidence: 'adagents_json' | 'agent_claim'): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, created_by, property_id_slug)
         VALUES ($1, $1, $2, $3, $4, 'site_main')
         RETURNING id`,
        [TEST_AGENT, TEST_PUB, evidence, evidence === 'agent_claim' ? TEST_AGENT : 'system']
      );
      return result.rows[0].id;
    }

    async function seedSuppressOverride(propertyIdSlug: string | null = 'site_main'): Promise<void> {
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification,
            approved_by_user_id, approved_by_email)
         VALUES ($1, $2, $2, $3, 'suppress', 'bad_actor',
                 'test', 'test_user', 'test@example.com')`,
        [TEST_PUB, TEST_AGENT, propertyIdSlug]
      );
    }

    async function seedAddOverride(propertyIdSlug: string | null = 'site_main'): Promise<void> {
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification,
            approved_by_user_id, approved_by_email, authorized_for)
         VALUES ($1, $2, $2, $3, 'add', 'correction',
                 'test', 'test_user', 'test@example.com', 'recovered')`,
        [TEST_PUB, TEST_AGENT, propertyIdSlug]
      );
    }

    it('surfaces a base adagents_json row as override_applied=FALSE when no override matches', async () => {
      await seedBaseRow('adagents_json');
      const { rows } = await pool.query<{ evidence: string; override_applied: boolean }>(
        `SELECT evidence, override_applied FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].evidence).toBe('adagents_json');
      expect(rows[0].override_applied).toBe(false);
    });

    it('hides a base row when a matching active suppress override exists', async () => {
      await seedBaseRow('adagents_json');
      await seedSuppressOverride('site_main');
      const { rows } = await pool.query(
        `SELECT * FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2
            AND evidence = 'adagents_json'`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(0);
    });

    it('passes agent_claim rows through the override layer (NOT suppressed by overrides)', async () => {
      // Override layer is scoped to evidence='adagents_json' rows only.
      await seedBaseRow('agent_claim');
      await seedSuppressOverride('site_main');
      const { rows } = await pool.query<{ evidence: string; override_applied: boolean }>(
        `SELECT evidence, override_applied FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].evidence).toBe('agent_claim');
      expect(rows[0].override_applied).toBe(false);
    });

    it('surfaces an add override as a phantom row even when no base row exists', async () => {
      await seedAddOverride('site_main');
      const { rows } = await pool.query<{
        evidence: string;
        override_applied: boolean;
        override_reason: string | null;
        property_rid: string | null;
        property_id_slug: string | null;
      }>(
        `SELECT evidence, override_applied, override_reason, property_rid, property_id_slug
           FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].evidence).toBe('override');
      expect(rows[0].override_applied).toBe(true);
      expect(rows[0].override_reason).toBe('correction');
      expect(rows[0].property_rid).toBeNull();
      expect(rows[0].property_id_slug).toBe('site_main');
    });

    it('add override with property_id IS NULL surfaces as a publisher-wide effective row', async () => {
      await seedAddOverride(null);
      const { rows } = await pool.query<{
        property_id_slug: string | null;
        publisher_domain: string;
        override_applied: boolean;
      }>(
        `SELECT property_id_slug, publisher_domain, override_applied
           FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].property_id_slug).toBeNull();
      expect(rows[0].publisher_domain).toBe(TEST_PUB);
      expect(rows[0].override_applied).toBe(true);
    });

    it('host-wide suppress (property_id IS NULL) hides every per-property base row under that publisher', async () => {
      // The dominant bad_actor use case: moderator suppresses an
      // attacker host-wide; every (host, agent) row across all
      // properties under that publisher must vanish from the
      // effective set.
      const propResult = await pool.query<{ property_rid: string }>(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, created_by)
         VALUES (gen_random_uuid(), 'home', 'property', 'authoritative', 'active', $1)
         RETURNING property_rid`,
        [`adagents_json:${TEST_PUB}`]
      );
      const rid = propResult.rows[0].property_rid;
      // Per-property base row.
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, property_rid, property_id_slug, evidence)
         VALUES ($1, $1, $2, 'home', 'adagents_json')`,
        [TEST_AGENT, rid]
      );
      // Host-wide suppress override (property_id IS NULL).
      await seedSuppressOverride(null);

      const { rows } = await pool.query(
        `SELECT * FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(0);

      // Cleanup the catalog_properties row we created here.
      await pool.query(`DELETE FROM catalog_agent_authorizations WHERE property_rid = $1`, [rid]);
      await pool.query(`DELETE FROM catalog_properties WHERE property_rid = $1`, [rid]);
    });

    it('host-wide suppress hides a publisher-wide base row', async () => {
      await seedBaseRow('adagents_json');
      // The seedBaseRow helper sets property_id_slug='site_main' but on
      // a publisher-wide row. Re-seed without slug for this test.
      await pool.query(
        `DELETE FROM catalog_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, created_by)
         VALUES ($1, $1, $2, 'adagents_json', 'system')`,
        [TEST_AGENT, TEST_PUB]
      );
      await seedSuppressOverride(null);
      const { rows } = await pool.query(
        `SELECT * FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2
            AND evidence = 'adagents_json'`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(0);
    });

    it('per-property suppress (property_id=slug) does NOT hide a base row with a different slug', async () => {
      // Seed two per-property base rows under different catalog properties.
      const propA = await pool.query<{ property_rid: string }>(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, created_by)
         VALUES (gen_random_uuid(), 'home', 'property', 'authoritative', 'active', $1)
         RETURNING property_rid`,
        [`adagents_json:${TEST_PUB}`]
      );
      const propB = await pool.query<{ property_rid: string }>(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, created_by)
         VALUES (gen_random_uuid(), 'news', 'property', 'authoritative', 'active', $1)
         RETURNING property_rid`,
        [`adagents_json:${TEST_PUB}`]
      );
      const ridA = propA.rows[0].property_rid;
      const ridB = propB.rows[0].property_rid;
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, property_rid, property_id_slug, evidence)
         VALUES ($1, $1, $2, 'home', 'adagents_json'),
                ($1, $1, $3, 'news', 'adagents_json')`,
        [TEST_AGENT, ridA, ridB]
      );
      // Suppress only the 'home' slug.
      await seedSuppressOverride('home');

      const { rows } = await pool.query<{ property_id_slug: string }>(
        `SELECT property_id_slug FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2
            AND evidence = 'adagents_json'`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows.map((r) => r.property_id_slug)).toEqual(['news']);

      await pool.query(
        `DELETE FROM catalog_agent_authorizations WHERE property_rid IN ($1, $2)`,
        [ridA, ridB]
      );
      await pool.query(`DELETE FROM catalog_properties WHERE property_rid IN ($1, $2)`, [ridA, ridB]);
    });

    it('does NOT surface superseded overrides', async () => {
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification,
            approved_by_user_id, approved_by_email,
            superseded_at, superseded_by_user_id, superseded_reason)
         VALUES ($1, $2, $2, 'site_main', 'add', 'correction',
                 'test', 'test_user', 'test@example.com',
                 NOW(), 'test_user', 'manual_lift')`,
        [TEST_PUB, TEST_AGENT]
      );
      const { rows } = await pool.query(
        `SELECT * FROM v_effective_agent_authorizations
          WHERE agent_url_canonical = $1 AND publisher_domain = $2`,
        [TEST_AGENT, TEST_PUB]
      );
      expect(rows).toHaveLength(0);
    });
  });
});
