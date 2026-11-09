import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.DATABASE_URL;

describe.skipIf(!testUrl)('reporting configuration storage after application migrations', () => {
  let pool: Pool;
  beforeAll(() => {
    const url = new URL(testUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/adcp_test') {
      throw new Error('Tests require the migrated local adcp_test database.');
    }
    pool = new Pool({ connectionString: testUrl, max: 1, connectionTimeoutMillis: 5000 });
  });
  afterAll(async () => { await pool?.end(); });

  it.each([null, '2026-10-01T00:00:00.000Z'])('accepts the SDK configuration insert with history_start=%s', async historyStart => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = `migration-regression-${randomUUID()}`;
      // reporting-storage writes history_start even when no override was
      // requested. Exercise that INSERT against the actual migrated table;
      // a missed migration must fail before a real configuration is provisioned.
      const result = await client.query(`
        INSERT INTO training_reporting_gcs.adcp_reporting_configurations (
          configuration_id, account_id, delivery_config_id, delivery_config_version,
          semantic_fingerprint, data, created_at, history_start
        ) VALUES ($1, $1, $1, 1, $2, '{}'::jsonb, NOW(), $3)
        RETURNING history_start`, [id, '0'.repeat(64), historyStart]);
      expect(result.rows).toEqual([{ history_start: historyStart === null ? null : new Date(historyStart) }]);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });
});
