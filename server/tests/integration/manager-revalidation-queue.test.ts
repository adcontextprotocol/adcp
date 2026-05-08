/**
 * Integration tests for the manager revalidation queue (#4200 item 2).
 *
 * When a manager rotates its adagents.json, every publisher delegating
 * via ads.txt MANAGERDOMAIN needs to be re-validated. The queue is the
 * fan-out primitive; the crawler worker drains it at a bounded rate.
 *
 * Shape mirrors catalog_crawl_queue (migration 367) — DB-backed, idempotent
 * insert, exponential backoff on failure, deletion on success.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';
import type { Pool } from 'pg';

const MANAGER_DOMAIN = 'manager-revalidation-test.example.com';
const PUB_A = 'pub-a.manager-revalidation-test.example.com';
const PUB_B = 'pub-b.manager-revalidation-test.example.com';
const PUB_C = 'pub-c.manager-revalidation-test.example.com';

describe('Manager revalidation queue', () => {
  let pool: Pool;
  let publisherDb: PublisherDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    publisherDb = new PublisherDatabase();
  });

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM manager_revalidation_queue WHERE publisher_domain = ANY($1::text[])`,
      [[PUB_A, PUB_B, PUB_C]],
    );
    await pool.query(
      `DELETE FROM publishers WHERE domain = ANY($1::text[])`,
      [[PUB_A, PUB_B, PUB_C, MANAGER_DOMAIN]],
    );
  }

  beforeEach(async () => {
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  async function seedDelegatingPublisher(domain: string, manager: string): Promise<void> {
    await pool.query(
      `INSERT INTO publishers (domain, source_type, manager_domain, discovery_method, last_validated)
       VALUES ($1, 'adagents_json', $2, 'ads_txt_managerdomain', NOW())`,
      [domain, manager],
    );
  }

  describe('enqueueManagerRevalidation', () => {
    it('inserts one queue row per delegating publisher', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await seedDelegatingPublisher(PUB_B, MANAGER_DOMAIN);

      const enqueued = await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);
      expect(enqueued).toBe(2);

      const rows = await pool.query(
        `SELECT publisher_domain, manager_domain, attempts, last_error
           FROM manager_revalidation_queue
          WHERE manager_domain = $1
          ORDER BY publisher_domain ASC`,
        [MANAGER_DOMAIN],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].publisher_domain).toBe(PUB_A);
      expect(rows.rows[0].manager_domain).toBe(MANAGER_DOMAIN);
      expect(rows.rows[0].attempts).toBe(0);
      expect(rows.rows[0].last_error).toBeNull();
      expect(rows.rows[1].publisher_domain).toBe(PUB_B);
    });

    it('is idempotent and resets attempts on re-enqueue', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      // Simulate a prior failure that put the row into backoff.
      await publisherDb.markRevalidationFailed(PUB_A, 'first try failed');
      const afterFailure = await pool.query(
        `SELECT attempts, last_error, next_attempt_after
           FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [PUB_A],
      );
      expect(afterFailure.rows[0].attempts).toBe(1);
      expect(afterFailure.rows[0].last_error).toBe('first try failed');
      expect(new Date(afterFailure.rows[0].next_attempt_after).getTime())
        .toBeGreaterThan(Date.now());

      // Manager rotates again — re-enqueue should reset attempts and
      // mark the row as due now, superseding the in-flight backoff.
      const second = await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);
      expect(second).toBe(1);

      const afterRequeue = await pool.query(
        `SELECT attempts, last_error, next_attempt_after
           FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [PUB_A],
      );
      expect(afterRequeue.rows[0].attempts).toBe(0);
      expect(afterRequeue.rows[0].last_error).toBeNull();
      expect(new Date(afterRequeue.rows[0].next_attempt_after).getTime())
        .toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('returns 0 and inserts nothing when no publishers delegate to the manager', async () => {
      const enqueued = await publisherDb.enqueueManagerRevalidation('unknown-manager.example.com');
      expect(enqueued).toBe(0);
    });
  });

  describe('dequeueRevalidationBatch', () => {
    it('returns only rows that are due (next_attempt_after <= NOW)', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await seedDelegatingPublisher(PUB_B, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      // Push PUB_B into the future.
      await pool.query(
        `UPDATE manager_revalidation_queue
            SET next_attempt_after = NOW() + INTERVAL '1 hour'
          WHERE publisher_domain = $1`,
        [PUB_B],
      );

      const batch = await publisherDb.dequeueRevalidationBatch(50);
      expect(batch.map(r => r.publisher_domain)).toEqual([PUB_A]);
    });

    it('respects the limit', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await seedDelegatingPublisher(PUB_B, MANAGER_DOMAIN);
      await seedDelegatingPublisher(PUB_C, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      const batch = await publisherDb.dequeueRevalidationBatch(2);
      expect(batch).toHaveLength(2);
    });

    it('orders oldest-first by enqueued_at', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await seedDelegatingPublisher(PUB_B, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      // Backdate PUB_B so it appears older.
      await pool.query(
        `UPDATE manager_revalidation_queue
            SET enqueued_at = NOW() - INTERVAL '1 hour'
          WHERE publisher_domain = $1`,
        [PUB_B],
      );

      const batch = await publisherDb.dequeueRevalidationBatch(50);
      expect(batch.map(r => r.publisher_domain)).toEqual([PUB_B, PUB_A]);
    });
  });

  describe('markRevalidationSucceeded / Failed', () => {
    it('deletes the row on success', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      await publisherDb.markRevalidationSucceeded(PUB_A);

      const rows = await pool.query(
        `SELECT 1 FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [PUB_A],
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('advances backoff geometrically on failure', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      const startMs = Date.now();
      await publisherDb.markRevalidationFailed(PUB_A, 'boom');
      const r1 = await pool.query(
        `SELECT next_attempt_after, attempts FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [PUB_A],
      );
      expect(r1.rows[0].attempts).toBe(1);
      // First backoff is ~1 hour (3,600,000ms). Allow generous slop.
      const delay1Ms = new Date(r1.rows[0].next_attempt_after).getTime() - startMs;
      expect(delay1Ms).toBeGreaterThan(50 * 60 * 1000);
      expect(delay1Ms).toBeLessThan(70 * 60 * 1000);

      await publisherDb.markRevalidationFailed(PUB_A, 'boom2');
      const r2 = await pool.query(
        `SELECT next_attempt_after, attempts FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [PUB_A],
      );
      expect(r2.rows[0].attempts).toBe(2);
      // Second backoff is ~6 hours.
      const delay2Ms = new Date(r2.rows[0].next_attempt_after).getTime() - startMs;
      expect(delay2Ms).toBeGreaterThan(5 * 60 * 60 * 1000);
      expect(delay2Ms).toBeLessThan(7 * 60 * 60 * 1000);
    });

    it('truncates last_error to 500 chars', async () => {
      await seedDelegatingPublisher(PUB_A, MANAGER_DOMAIN);
      await publisherDb.enqueueManagerRevalidation(MANAGER_DOMAIN);

      const longErr = 'x'.repeat(2000);
      await publisherDb.markRevalidationFailed(PUB_A, longErr);

      const r = await pool.query(
        `SELECT last_error FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [PUB_A],
      );
      expect(r.rows[0].last_error).toHaveLength(500);
    });
  });
});
