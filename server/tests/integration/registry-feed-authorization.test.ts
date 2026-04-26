/**
 * Authorization events on the registry change feed (PR 4b-feed of #3177).
 *
 * Migration 442 adds Postgres triggers on catalog_agent_authorizations
 * and adagents_authorization_overrides that emit
 * authorization.granted / .revoked / .modified events. The wire format
 * is pinned in specs/registry-authorization-model.md ("Change-feed event
 * shape" section).
 *
 * Reader contract: zero changes to /api/registry/feed — the existing
 * event_type glob filter (`?types=authorization.*`) already passes the
 * new events through.
 *
 * Refs #3177. Builds on #3274 (schema). Spec #3251.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const TEST_PUB = 'feed-auth.example';
const TEST_AGENT = 'https://agent.feed-auth.example';
const TEST_AGENT_OTHER = 'https://other.feed-auth.example';

interface CatalogEvent {
  event_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: Date;
}

describe('442_authorization_feed_emitter triggers', () => {
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
      `DELETE FROM catalog_events
        WHERE entity_type = 'authorization'
          AND (payload->>'publisher_domain' = $1
            OR payload->>'agent_url_canonical' IN ($2, $3))`,
      [TEST_PUB, TEST_AGENT, TEST_AGENT_OTHER]
    );
    await pool.query(
      `DELETE FROM adagents_authorization_overrides WHERE host_domain = $1`,
      [TEST_PUB]
    );
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE agent_url_canonical IN ($1, $2) OR publisher_domain = $3`,
      [TEST_AGENT, TEST_AGENT_OTHER, TEST_PUB]
    );
    await pool.query(
      `DELETE FROM catalog_properties WHERE created_by = $1`,
      [`adagents_json:${TEST_PUB}`]
    );
  }

  beforeEach(async () => {
    await clearTestFixtures();
  });

  afterAll(async () => {
    await clearTestFixtures();
    await closeDatabase();
  });

  async function eventsForFixtures(
    eventTypeFilter?: 'authorization.granted' | 'authorization.revoked' | 'authorization.modified',
  ): Promise<CatalogEvent[]> {
    const params: string[] = [TEST_PUB, TEST_AGENT, TEST_AGENT_OTHER];
    let typeClause = '';
    if (eventTypeFilter) {
      typeClause = ' AND event_type = $4';
      params.push(eventTypeFilter);
    }
    const { rows } = await pool.query<CatalogEvent>(
      `SELECT event_id, event_type, entity_type, entity_id, payload, actor, created_at
         FROM catalog_events
        WHERE entity_type = 'authorization'
          AND (payload->>'publisher_domain' = $1
            OR payload->>'agent_url_canonical' IN ($2, $3))
          ${typeClause}
        ORDER BY event_id`,
      params
    );
    return rows;
  }

  describe('catalog_agent_authorizations triggers', () => {
    it('INSERT live row → 1 authorization.granted event with full payload', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, authorized_for)
         VALUES ($1, $1, $2, 'adagents_json', 'display+video')
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );

      const events = await eventsForFixtures();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('authorization.granted');
      expect(events[0].entity_type).toBe('authorization');
      expect(events[0].entity_id).toBe(inserted.rows[0].id);
      expect(events[0].actor).toBe('trigger:caa_emit_event');
      expect(events[0].payload.agent_url).toBe(TEST_AGENT);
      expect(events[0].payload.agent_url_canonical).toBe(TEST_AGENT);
      expect(events[0].payload.publisher_domain).toBe(TEST_PUB);
      expect(events[0].payload.evidence).toBe('adagents_json');
      expect(events[0].payload.authorized_for).toBe('display+video');
      expect(events[0].payload.override_applied).toBe(false);
      expect(events[0].payload.override_reason).toBeNull();
    });

    it('INSERT row already tombstoned (backfill replay) emits NO event', async () => {
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, deleted_at)
         VALUES ($1, $1, $2, 'adagents_json', NOW())`,
        [TEST_AGENT, TEST_PUB]
      );
      const events = await eventsForFixtures();
      expect(events).toHaveLength(0);
    });

    it('soft-delete (deleted_at NULL → NOT NULL) → authorization.revoked', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );
      await pool.query(
        `UPDATE catalog_agent_authorizations SET deleted_at = NOW() WHERE id = $1`,
        [inserted.rows[0].id]
      );

      const events = await eventsForFixtures();
      expect(events.map((e) => e.event_type)).toEqual([
        'authorization.granted',
        'authorization.revoked',
      ]);
      expect(events[1].entity_id).toBe(inserted.rows[0].id);
    });

    it('un-tombstone (deleted_at NOT NULL → NULL) → authorization.granted', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, deleted_at)
         VALUES ($1, $1, $2, 'adagents_json', NOW())
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );
      await pool.query(
        `UPDATE catalog_agent_authorizations SET deleted_at = NULL WHERE id = $1`,
        [inserted.rows[0].id]
      );

      const events = await eventsForFixtures();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('authorization.granted');
    });

    it.each([
      ['authorized_for', `'display'`, `'video'`],
      ['disputed', 'FALSE', 'TRUE'],
    ])(
      'UPDATE %s on a live row → authorization.modified',
      async (column, oldVal, newVal) => {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence, ${column})
           VALUES ($1, $1, $2, 'adagents_json', ${oldVal})
           RETURNING id`,
          [TEST_AGENT, TEST_PUB]
        );
        await pool.query(
          `UPDATE catalog_agent_authorizations SET ${column} = ${newVal} WHERE id = $1`,
          [inserted.rows[0].id]
        );

        const modified = await eventsForFixtures('authorization.modified');
        expect(modified).toHaveLength(1);
        expect(modified[0].entity_id).toBe(inserted.rows[0].id);
      }
    );

    it('UPDATE expires_at on an agent_claim row → authorization.modified', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence, created_by)
         VALUES ($1, $1, $2, 'agent_claim', $1)
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );
      await pool.query(
        `UPDATE catalog_agent_authorizations SET expires_at = NOW() + interval '7 days' WHERE id = $1`,
        [inserted.rows[0].id]
      );
      const modified = await eventsForFixtures('authorization.modified');
      expect(modified).toHaveLength(1);
    });

    it('UPDATE that touches no externally-visible field → NO event', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $1, $2, 'adagents_json')
         RETURNING id`,
        [TEST_AGENT, TEST_PUB]
      );
      await pool.query(
        `UPDATE catalog_agent_authorizations SET updated_at = NOW() WHERE id = $1`,
        [inserted.rows[0].id]
      );
      const events = await eventsForFixtures();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('authorization.granted');
    });
  });

  describe('adagents_authorization_overrides triggers', () => {
    /**
     * Seed a base row matching the schema's mutually-exclusive scope CHECK:
     * - slug=null  → publisher-wide (property_rid IS NULL, publisher_domain set)
     * - slug='X'   → per-property (property_rid set, publisher_domain NULL).
     *                Auto-creates a catalog_properties row with
     *                created_by='adagents_json:TEST_PUB' so the override
     *                trigger's publisher_domain derivation matches.
     */
    async function seedBaseRow(
      args: { evidence?: 'adagents_json' | 'agent_claim' | 'community'; slug?: string | null } = {}
    ): Promise<string> {
      const { evidence = 'adagents_json', slug = null } = args;
      const createdBy = evidence === 'agent_claim' ? TEST_AGENT : 'system';

      if (slug === null) {
        const result = await pool.query<{ id: string }>(
          `INSERT INTO catalog_agent_authorizations
             (agent_url, agent_url_canonical, publisher_domain, evidence, created_by)
           VALUES ($1, $1, $2, $3, $4)
           RETURNING id`,
          [TEST_AGENT, TEST_PUB, evidence, createdBy]
        );
        return result.rows[0].id;
      }

      const propResult = await pool.query<{ property_rid: string }>(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, created_by)
         VALUES (gen_random_uuid(), $1, 'property', 'authoritative', 'active', $2)
         RETURNING property_rid`,
        [slug, `adagents_json:${TEST_PUB}`]
      );
      const rid = propResult.rows[0].property_rid;

      const result = await pool.query<{ id: string }>(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, property_rid, property_id_slug, evidence, created_by)
         VALUES ($1, $1, $2, $3, $4, $5)
         RETURNING id`,
        [TEST_AGENT, rid, slug, evidence, createdBy]
      );
      return result.rows[0].id;
    }

    async function insertSuppressOverride(args: { slug?: string | null } = {}): Promise<string> {
      const { slug = null } = args;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification,
            approved_by_user_id, approved_by_email)
         VALUES ($1, $2, $2, $3, 'suppress', 'bad_actor',
                 'test', 'test_user', 'test@example.com')
         RETURNING id`,
        [TEST_PUB, TEST_AGENT, slug]
      );
      return result.rows[0].id;
    }

    async function insertAddOverride(args: { slug?: string | null } = {}): Promise<string> {
      const { slug = null } = args;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, property_id,
            override_type, override_reason, justification,
            approved_by_user_id, approved_by_email, authorized_for)
         VALUES ($1, $2, $2, $3, 'add', 'correction',
                 'test', 'test_user', 'test@example.com', 'recovered')
         RETURNING id`,
        [TEST_PUB, TEST_AGENT, slug]
      );
      return result.rows[0].id;
    }

    it('insert active "add" override → 1 authorization.granted event', async () => {
      const overrideId = await insertAddOverride({ slug: 'site_main' });

      const events = await eventsForFixtures('authorization.granted');
      expect(events).toHaveLength(1);
      expect(events[0].entity_id).toBe(overrideId);
      expect(events[0].actor).toBe('trigger:aao_emit_event');
      expect(events[0].payload.evidence).toBe('override');
      expect(events[0].payload.override_applied).toBe(true);
      expect(events[0].payload.override_reason).toBe('correction');
      expect(events[0].payload.property_rid).toBeNull();
      expect(events[0].payload.property_id_slug).toBe('site_main');
    });

    it('insert active "suppress" override matching N adagents_json rows → N authorization.revoked events', async () => {
      const id1 = await seedBaseRow({ slug: 'site_a' });
      const id2 = await seedBaseRow({ slug: 'site_b' });
      const id3 = await seedBaseRow({ slug: null });
      await insertSuppressOverride({ slug: null });

      const revokedEvents = await eventsForFixtures('authorization.revoked');
      expect(revokedEvents).toHaveLength(3);
      const revokedIds = revokedEvents.map((e) => e.entity_id).sort();
      expect(revokedIds).toEqual([id1, id2, id3].sort());
      for (const ev of revokedEvents) {
        expect(ev.payload.override_applied).toBe(true);
        expect(ev.payload.override_reason).toBe('bad_actor');
      }
    });

    it('per-property suppress only fans out to base rows with matching slug', async () => {
      const idHome = await seedBaseRow({ slug: 'home' });
      await seedBaseRow({ slug: 'news' });
      await insertSuppressOverride({ slug: 'home' });

      const revokedEvents = await eventsForFixtures('authorization.revoked');
      expect(revokedEvents).toHaveLength(1);
      expect(revokedEvents[0].entity_id).toBe(idHome);
    });

    it('suppress override against agent_claim or community rows fires NO override-driven event', async () => {
      await seedBaseRow({ evidence: 'agent_claim', slug: 'claim_slug' });
      await seedBaseRow({ evidence: 'community', slug: 'community_slug' });
      await insertSuppressOverride({ slug: null });

      const revokedEvents = await eventsForFixtures('authorization.revoked');
      expect(revokedEvents).toHaveLength(0);
    });

    it('supersede an active "add" override → 1 authorization.revoked', async () => {
      const overrideId = await insertAddOverride({ slug: 'site_main' });

      await pool.query(
        `UPDATE adagents_authorization_overrides
            SET superseded_at = NOW(),
                superseded_by_user_id = 'test_user',
                superseded_reason = 'manual_lift'
          WHERE id = $1`,
        [overrideId]
      );

      const revokedEvents = await eventsForFixtures('authorization.revoked');
      expect(revokedEvents).toHaveLength(1);
      expect(revokedEvents[0].entity_id).toBe(overrideId);
      // Symmetry with the suppress-supersede case: override_applied is FALSE
      // because the override is no longer active.
      expect(revokedEvents[0].payload.override_applied).toBe(false);
    });

    it('suppress override with zero matching base rows fires NO override-driven event', async () => {
      // Insert a suppress override targeting an agent that has no active CAA
      // rows for this publisher. Trigger should iterate the LOOP zero times
      // and emit nothing — the override sits in the table waiting to fire
      // via the CAA trigger if a matching base row appears later.
      await insertSuppressOverride({ slug: null });

      const overrideEvents = (await eventsForFixtures()).filter(
        (e) => e.actor === 'trigger:aao_emit_event'
      );
      expect(overrideEvents).toHaveLength(0);
    });

    it('supersede an active "suppress" override → fan-out N authorization.granted events', async () => {
      const id1 = await seedBaseRow({ slug: 'site_a' });
      const id2 = await seedBaseRow({ slug: 'site_b' });
      const overrideId = await insertSuppressOverride({ slug: null });

      await pool.query(
        `UPDATE adagents_authorization_overrides
            SET superseded_at = NOW(),
                superseded_by_user_id = 'test_user',
                superseded_reason = 'manual_lift'
          WHERE id = $1`,
        [overrideId]
      );

      const grantedEvents = await eventsForFixtures('authorization.granted');
      expect(grantedEvents).toHaveLength(4);
      const supersedeGranted = grantedEvents.filter(
        (e) => e.actor === 'trigger:aao_emit_event'
      );
      expect(supersedeGranted).toHaveLength(2);
      expect(supersedeGranted.map((e) => e.entity_id).sort()).toEqual([id1, id2].sort());
      for (const ev of supersedeGranted) {
        expect(ev.payload.override_applied).toBe(false);
      }
    });

    it('insert with superseded_at already set (historical replay) emits NO event', async () => {
      await seedBaseRow();
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical,
            override_type, override_reason, justification,
            approved_by_user_id, approved_by_email,
            superseded_at, superseded_by_user_id, superseded_reason)
         VALUES ($1, $2, $2, 'suppress', 'bad_actor',
                 'historical', 'test_user', 'test@example.com',
                 NOW(), 'test_user', 'manual_lift')`,
        [TEST_PUB, TEST_AGENT]
      );

      const overrideEvents = (await eventsForFixtures()).filter(
        (e) => e.actor === 'trigger:aao_emit_event'
      );
      expect(overrideEvents).toHaveLength(0);
    });
  });

  describe('uuidv7() helper', () => {
    it('generates UUIDs that compare in time-order for sequential calls', async () => {
      const { rows } = await pool.query<{ u: string }>(
        `SELECT uuidv7() AS u FROM generate_series(1, 50)`
      );
      const ids = rows.map((r) => r.u);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    it('produces version-7 + variant-10 UUIDs', async () => {
      const { rows } = await pool.query<{ u: string }>(`SELECT uuidv7() AS u`);
      const u = rows[0].u;
      expect(u[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(u[19].toLowerCase());
    });
  });
});
