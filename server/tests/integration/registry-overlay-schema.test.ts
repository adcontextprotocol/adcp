/**
 * Smoke test for migration 431_publishers_overlay.
 *
 * Asserts the schema invariants that PR #3195 commits to are actually
 * enforced by the database — not just documented in comments. The CHECK
 * constraints and partial unique index are load-bearing security controls
 * (see the security review summarized on #3195: silent re-authorization of
 * a banned bad actor is the worst-case failure mode), and a typo'd index
 * or missing constraint would degrade silently.
 *
 * Tests-only — no production code touched. Runs against the same test
 * Postgres as the rest of `server/tests/integration/`.
 *
 * Closes #3205.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const TEST_HOST = 'overlay-schema.example.com';
const TEST_AGENT = 'https://agent.overlay-schema.example.com';
const TEST_AGENT_CANON = 'https://agent.overlay-schema.example.com';

describe('431_publishers_overlay schema', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  // Scope cleanup to this file's specific fixtures.
  async function clearTestFixtures() {
    await pool.query('DELETE FROM adagents_authorization_overrides WHERE host_domain = $1', [TEST_HOST]);
    await pool.query('DELETE FROM publishers WHERE domain = $1', [TEST_HOST]);
  }

  afterAll(async () => {
    await clearTestFixtures();
    await closeDatabase();
  });

  describe('publishers table', () => {
    it('exists with the expected columns', async () => {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'publishers'
          ORDER BY column_name`,
      );
      const columns = new Set(rows.map((r) => r.column_name));
      const expected = [
        'domain',
        'adagents_json',
        'source_type',
        'domain_verified',
        'last_validated',
        'expires_at',
        'workos_organization_id',
        'created_by_user_id',
        'created_by_email',
        'review_status',
        'is_public',
        'created_at',
        'updated_at',
      ];
      for (const col of expected) {
        expect(columns).toContain(col);
      }
    });

    it('rejects invalid source_type values', async () => {
      await expect(
        pool.query(
          `INSERT INTO publishers (domain, source_type) VALUES ($1, $2)`,
          [TEST_HOST, 'not_a_real_source_type'],
        ),
      ).rejects.toThrow(/source_type/);
    });
  });

  describe('adagents_authorization_overrides table', () => {
    it('exists with the expected columns', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_name = 'adagents_authorization_overrides'
          ORDER BY column_name`,
      );
      const columns = new Set(rows.map((r) => r.column_name));
      const expected = [
        'id',
        'host_domain',
        'agent_url',
        'agent_url_canonical',
        'property_id',
        'override_type',
        'override_reason',
        'authorized_for',
        'justification',
        'evidence_url',
        'approved_by_user_id',
        'approved_by_email',
        'created_at',
        'expires_at',
        'superseded_at',
        'superseded_by_user_id',
        'superseded_reason',
      ];
      for (const col of expected) {
        expect(columns).toContain(col);
      }
    });

    it('idx_aao_unique_active is a partial unique index gated on superseded_at IS NULL', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_aao_unique_active'`,
      );
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toMatch(/UNIQUE/i);
      expect(def).toMatch(/host_domain/);
      expect(def).toMatch(/agent_url_canonical/);
      expect(def).toMatch(/COALESCE\(property_id/i);
      expect(def).toMatch(/override_type/);
      expect(def).toMatch(/WHERE.*superseded_at IS NULL/i);
    });

    it('lists all expected named indexes', async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'adagents_authorization_overrides'`,
      );
      const names = new Set(rows.map((r) => r.indexname));
      const expected = [
        'idx_aao_unique_active',
        'idx_aao_host',
        'idx_aao_agent',
        'idx_aao_reason',
        'idx_aao_expires',
        'idx_aao_created',
      ];
      for (const idx of expected) {
        expect(names).toContain(idx);
      }
    });
  });

  describe('schema invariants — CHECK constraints', () => {
    async function seedPublisher() {
      await pool.query(
        `INSERT INTO publishers (domain, source_type) VALUES ($1, 'adagents_json')
           ON CONFLICT (domain) DO NOTHING`,
        [TEST_HOST],
      );
    }

    function insertOverride(args: {
      override_type?: 'add' | 'suppress';
      override_reason: 'bad_actor' | 'correction' | 'file_broken';
      property_id?: string | null;
      expires_at?: Date | null;
      superseded_at?: Date | null;
      superseded_by_user_id?: string | null;
      superseded_reason?: string | null;
      agent_url_canonical?: string;
    }) {
      return pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification,
            approved_by_user_id, expires_at,
            superseded_at, superseded_by_user_id, superseded_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          TEST_HOST,
          TEST_AGENT,
          args.agent_url_canonical ?? TEST_AGENT_CANON,
          args.property_id ?? null,
          args.override_type ?? 'suppress',
          args.override_reason,
          'integration test',
          'user_test_approver',
          args.expires_at ?? null,
          args.superseded_at ?? null,
          args.superseded_by_user_id ?? null,
          args.superseded_reason ?? null,
        ],
      );
    }

    beforeAll(async () => {
      await seedPublisher();
    });

    it('rejects bad_actor override with a non-NULL expires_at', async () => {
      await expect(
        insertOverride({
          override_reason: 'bad_actor',
          expires_at: new Date('2027-01-01T00:00:00Z'),
        }),
      ).rejects.toThrow(/chk_aao_bad_actor_no_expiry/);
    });

    it('accepts bad_actor override with NULL expires_at', async () => {
      const result = await insertOverride({
        override_reason: 'bad_actor',
        property_id: 'invariant-bad-actor-1',
      });
      expect(result.rows[0].id).toBeDefined();
    });

    it("rejects bad_actor override superseded with reason='publisher_corrected' (auto-restore via clean re-crawl)", async () => {
      const now = new Date();
      await expect(
        insertOverride({
          override_reason: 'bad_actor',
          property_id: 'invariant-bad-actor-2',
          superseded_at: now,
          superseded_by_user_id: 'system:reconcile',
          superseded_reason: 'publisher_corrected',
        }),
      ).rejects.toThrow(/chk_aao_supersede_reason/);
    });

    it("rejects bad_actor override superseded with reason='expired'", async () => {
      const now = new Date();
      await expect(
        insertOverride({
          override_reason: 'bad_actor',
          property_id: 'invariant-bad-actor-3',
          superseded_at: now,
          superseded_by_user_id: 'system:reconcile',
          superseded_reason: 'expired',
        }),
      ).rejects.toThrow(/chk_aao_supersede_reason/);
    });

    it("accepts bad_actor override superseded only with reason='manual_lift'", async () => {
      const now = new Date();
      const result = await insertOverride({
        override_reason: 'bad_actor',
        property_id: 'invariant-bad-actor-4',
        superseded_at: now,
        superseded_by_user_id: 'user_test_approver_2',
        superseded_reason: 'manual_lift',
      });
      expect(result.rows[0].id).toBeDefined();
    });

    it('rejects partial supersession state (superseded_at set without superseded_reason)', async () => {
      await expect(
        insertOverride({
          override_reason: 'correction',
          property_id: 'invariant-partial-1',
          superseded_at: new Date(),
          superseded_by_user_id: 'user_test_approver',
          superseded_reason: null,
        }),
      ).rejects.toThrow(/chk_aao_supersede_consistency/);
    });

    it('rejects non-canonical agent_url_canonical (uppercase)', async () => {
      await expect(
        insertOverride({
          override_reason: 'correction',
          property_id: 'invariant-canon-1',
          agent_url_canonical: 'https://Agent.Overlay-Schema.Example.Com',
        }),
      ).rejects.toThrow(/chk_aao_agent_url_canonical/);
    });

    it('rejects non-canonical agent_url_canonical (trailing slash)', async () => {
      await expect(
        insertOverride({
          override_reason: 'correction',
          property_id: 'invariant-canon-2',
          agent_url_canonical: 'https://agent.overlay-schema.example.com/',
        }),
      ).rejects.toThrow(/chk_aao_agent_url_canonical/);
    });
  });

  describe('partial unique index behavior', () => {
    async function seedPublisher() {
      await pool.query(
        `INSERT INTO publishers (domain, source_type) VALUES ($1, 'adagents_json')
           ON CONFLICT (domain) DO NOTHING`,
        [TEST_HOST],
      );
    }

    beforeAll(async () => {
      await seedPublisher();
    });

    it('blocks two active rows with the same (host, agent, property_id, override_type)', async () => {
      const property = 'partial-unique-active';
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification, approved_by_user_id)
         VALUES ($1, $2, $3, $4, 'suppress', 'correction', 'a', 'u')`,
        [TEST_HOST, TEST_AGENT, TEST_AGENT_CANON, property],
      );

      await expect(
        pool.query(
          `INSERT INTO adagents_authorization_overrides
             (host_domain, agent_url, agent_url_canonical, property_id,
              override_type, override_reason, justification, approved_by_user_id)
           VALUES ($1, $2, $3, $4, 'suppress', 'correction', 'b', 'u')`,
          [TEST_HOST, TEST_AGENT, TEST_AGENT_CANON, property],
        ),
      ).rejects.toThrow(/idx_aao_unique_active|duplicate key/);
    });

    it('permits a new active row after the prior row is superseded', async () => {
      const property = 'partial-unique-after-supersede';

      const first = await pool.query<{ id: string }>(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification, approved_by_user_id)
         VALUES ($1, $2, $3, $4, 'suppress', 'correction', 'a', 'u')
         RETURNING id`,
        [TEST_HOST, TEST_AGENT, TEST_AGENT_CANON, property],
      );

      await pool.query(
        `UPDATE adagents_authorization_overrides
            SET superseded_at = NOW(),
                superseded_by_user_id = 'u2',
                superseded_reason = 'manual_lift'
          WHERE id = $1`,
        [first.rows[0].id],
      );

      // Now the same key can re-enter as a new active row — audit
      // accumulates rather than blocking re-entry, per the security review's
      // intentional design. Resurrection-by-recreate awareness is an
      // application-layer concern for high-risk reasons (bad_actor).
      const second = await pool.query<{ id: string }>(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification, approved_by_user_id)
         VALUES ($1, $2, $3, $4, 'suppress', 'correction', 'b', 'u')
         RETURNING id`,
        [TEST_HOST, TEST_AGENT, TEST_AGENT_CANON, property],
      );
      expect(second.rows[0].id).toBeDefined();
      expect(second.rows[0].id).not.toBe(first.rows[0].id);
    });

    it('treats NULL property_id as a single bucket (publisher-wide overrides are unique per host+agent+type)', async () => {
      // First publisher-wide row succeeds.
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification, approved_by_user_id)
         VALUES ($1, $2, $3, NULL, 'suppress', 'bad_actor', 'a', 'u')`,
        [TEST_HOST, TEST_AGENT, TEST_AGENT_CANON],
      );

      // Second publisher-wide row with the same key is blocked by COALESCE
      // in the partial unique index — this is exactly what plain UNIQUE
      // would have permitted (Postgres treats NULLs as distinct).
      await expect(
        pool.query(
          `INSERT INTO adagents_authorization_overrides
             (host_domain, agent_url, agent_url_canonical, property_id,
              override_type, override_reason, justification, approved_by_user_id)
           VALUES ($1, $2, $3, NULL, 'suppress', 'bad_actor', 'b', 'u')`,
          [TEST_HOST, TEST_AGENT, TEST_AGENT_CANON],
        ),
      ).rejects.toThrow(/idx_aao_unique_active|duplicate key/);
    });
  });
});
