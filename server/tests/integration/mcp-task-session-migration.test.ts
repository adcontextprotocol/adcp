import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresTaskStore } from '@adcp/sdk';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const LEGACY_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/383_mcp_task_store.sql'),
  'utf8',
);
const SESSION_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/631_mcp_task_session_ownership.sql'),
  'utf8',
);
const request = {
  method: 'tools/call',
  params: { name: 'get_products', arguments: {} },
};

describe.skipIf(!process.env.DATABASE_URL)('MCP task session ownership migration', () => {
  const schema = `mcp_task_migration_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(LEGACY_MIGRATION);
  });

  afterEach(async () => {
    await client?.query('ROLLBACK');
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('fixes SDK task creation and preserves caller isolation through completion', async () => {
    const store = new PostgresTaskStore(client);
    // Reproduce the reported failure against the pre-upgrade schema. The SDK
    // deliberately hides the database detail from clients, retaining its cause.
    await client.query('SAVEPOINT before_upgrade');
    await expect(store.createTask({ ttl: 60_000 }, 1, request, 'buyer_a')).rejects.toMatchObject({
      message: 'PostgresTaskStore.createTask: database operation failed',
      cause: { code: '42703' },
    });
    await client.query('ROLLBACK TO SAVEPOINT before_upgrade');
    await client.query(SESSION_MIGRATION);

    const task = await store.createTask({ ttl: 60_000 }, 1, request, 'buyer_a');
    expect(task.status).toBe('working');
    await expect(store.getTask(task.taskId, 'buyer_a')).resolves.toEqual(task);
    await expect(store.listTasks(undefined, 'buyer_a')).resolves.toMatchObject({ tasks: [task] });
    await expect(store.getTask(task.taskId, 'buyer_b')).resolves.toBeNull();
    await expect(store.listTasks(undefined, 'buyer_b')).resolves.toMatchObject({ tasks: [] });

    const result = { content: [{ type: 'text' as const, text: '{"products":[]}' }] };
    await expect(store.storeTaskResult(task.taskId, 'completed', result, 'buyer_b'))
      .rejects.toThrow('not found');
    await store.updateTaskStatus(task.taskId, 'working', 'Loading products', 'buyer_a');
    await store.storeTaskResult(task.taskId, 'completed', result, 'buyer_a');
    await expect(store.getTaskResult(task.taskId, 'buyer_a')).resolves.toEqual(result);
    await expect(store.getTaskResult(task.taskId, 'buyer_b')).rejects.toThrow('not found');
    await expect(store.getTask(task.taskId, 'buyer_a')).resolves.toMatchObject({ status: 'completed' });
  });

  it('retains legacy task results without exposing them to scoped callers', async () => {
    const result = { content: [{ type: 'text', text: '{"products":[]}' }] };
    await client.query(
      `INSERT INTO adcp_mcp_tasks (task_id, status, request_id, request, result)
       VALUES ('legacy_task', 'completed', '1', $1, $2)`,
      [JSON.stringify(request), JSON.stringify(result)],
    );
    await client.query(SESSION_MIGRATION);

    const scoped = new PostgresTaskStore(client);
    await expect(scoped.getTask('legacy_task', 'buyer_a')).resolves.toBeNull();
    await expect(scoped.listTasks(undefined, 'buyer_a')).resolves.toMatchObject({ tasks: [] });
    const worker = new PostgresTaskStore(client, { allowUnscopedAccess: true });
    await expect(worker.getTask('legacy_task')).resolves.toMatchObject({ status: 'completed' });
    await expect(worker.getTaskResult('legacy_task')).resolves.toEqual(result);
  });

  it('can be reapplied without losing task ownership or results', async () => {
    await client.query(SESSION_MIGRATION);
    const store = new PostgresTaskStore(client);
    const task = await store.createTask({ ttl: 60_000 }, 1, request, 'buyer_a');
    const result = { content: [{ type: 'text' as const, text: '{"products":[]}' }] };
    await store.storeTaskResult(task.taskId, 'completed', result, 'buyer_a');

    await client.query(SESSION_MIGRATION);
    await expect(store.getTask(task.taskId, 'buyer_a')).resolves.toMatchObject({ status: 'completed' });
    await expect(store.getTaskResult(task.taskId, 'buyer_a')).resolves.toEqual(result);
    await expect(store.getTask(task.taskId, 'buyer_b')).resolves.toBeNull();
  });
});
