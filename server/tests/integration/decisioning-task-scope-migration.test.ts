import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPostgresTaskRegistry } from '@adcp/sdk/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const TEST_SCHEMA = 'decisioning_task_scope_migration_test';
const LEGACY_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/463_adcp_decisioning_tasks.sql'),
  'utf8',
);
const SCOPED_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/560_scope_adcp_decisioning_tasks.sql'),
  'utf8',
);

describe.skipIf(!process.env.DATABASE_URL)('migration 560: scoped decisioning tasks', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await client.query(`SET search_path TO ${TEST_SCHEMA}`);
    await client.query(LEGACY_MIGRATION);
  });

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
    await pool?.end();
  });

  it('rolls back while an active legacy task exists', async () => {
    await client.query(
      `INSERT INTO adcp_decisioning_tasks (task_id, tool, account_id)
       VALUES ('legacy_active', 'create_media_buy', 'account_a')`,
    );

    await client.query('BEGIN');
    await expect(client.query(SCOPED_MIGRATION)).rejects.toThrow(
      'Drain active decisioning tasks before enabling the scoped task registry',
    );
    await client.query('ROLLBACK');

    const scopedTable = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'adcp_decisioning_tasks_v2'`,
      [TEST_SCHEMA],
    );
    expect(scopedTable.rows).toEqual([]);
    await client.query("DELETE FROM adcp_decisioning_tasks WHERE task_id = 'legacy_active'");
  });

  it('atomically retires legacy writers after a clean cutover', async () => {
    await client.query('BEGIN');
    await client.query(SCOPED_MIGRATION);
    await client.query('COMMIT');

    await expect(client.query(
      `INSERT INTO adcp_decisioning_tasks (task_id, tool, account_id)
       VALUES ('legacy_late', 'create_media_buy', 'account_a')`,
    )).rejects.toThrow('Legacy decisioning task writes are disabled');
  });

  it('stores the same public task id independently across owners and tenants', async () => {
    const sales = createPostgresTaskRegistry({
      pool: client,
      namespace: 'adcp-training-agent:sales',
      tableName: 'adcp_decisioning_tasks_v2',
    });
    const signals = createPostgresTaskRegistry({
      pool: client,
      namespace: 'adcp-training-agent:signals',
      tableName: 'adcp_decisioning_tasks_v2',
    });
    const taskId = 'task_shared_public_id';
    const ownerA = { accountId: 'account_a', ownerScope: 'agent:https://buyer-a.example' };
    const ownerB = { accountId: 'account_a', ownerScope: 'agent:https://buyer-b.example' };

    await sales.create({ tool: 'create_media_buy', ...ownerA, overrideTaskId: taskId });
    await sales.create({ tool: 'create_media_buy', ...ownerB, overrideTaskId: taskId });
    await signals.create({ tool: 'get_signals', ...ownerA, overrideTaskId: taskId });
    await sales.complete(taskId, ownerA, { media_buy_id: 'mb_owner_a' });

    await expect(sales.getTask(taskId, ownerA)).resolves.toMatchObject({
      taskId,
      status: 'completed',
      result: { media_buy_id: 'mb_owner_a' },
    });
    await expect(sales.getTask(taskId, ownerB)).resolves.toMatchObject({
      taskId,
      status: 'submitted',
    });
    await expect(signals.getTask(taskId, ownerA)).resolves.toMatchObject({
      taskId,
      status: 'submitted',
    });
  });
});
