import { PostgresTaskStore, type PgQueryable } from '@adcp/sdk';
import { describe, expect, it } from 'vitest';
import {
  createOrReuseIdempotentTask,
  getIdempotentTask,
  idempotentTaskId,
} from '../../src/training-agent/task-handlers.js';

type TaskRow = Record<string, unknown> & {
  task_id: string;
  status: string;
};

function taskRow(taskId: string, status: string): TaskRow {
  const now = new Date().toISOString();
  return {
    task_id: taskId,
    status,
    ttl: 86_400_000,
    poll_interval: 1000,
    status_message: null,
    request_id: '0',
    request: {},
    result: status === 'completed' ? { structuredContent: { proposals: [] } } : null,
    created_at: now,
    last_updated_at: now,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

class ExpiryAwareTaskDb implements PgQueryable {
  readonly rows = new Map<string, TaskRow>();
  readonly expiredIds = new Set<string>();
  readonly insertedIds: string[] = [];

  async query(text: string, values: unknown[] = []): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number;
  }> {
    const taskId = String(values[0]);
    if (text.includes('SELECT *') && text.includes('WHERE task_id = $1')) {
      const row = this.rows.get(taskId);
      return {
        rows: row && !this.expiredIds.has(taskId) ? [row] : [],
        rowCount: row && !this.expiredIds.has(taskId) ? 1 : 0,
      };
    }
    if (text.includes('INSERT INTO')) {
      if (this.rows.has(taskId)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const row = taskRow(taskId, 'working');
      this.rows.set(taskId, row);
      this.insertedIds.push(taskId);
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`Unexpected task-store query: ${text}`);
  }
}

const request = {
  method: 'tools/call',
  params: { name: 'get_products', arguments: { buying_mode: 'brief' } },
};

describe('Postgres idempotent task receipt generations', () => {
  it('finds a live replacement after an expired generation-zero hole', async () => {
    const naturalKey = 'principal\0get_products\0success:key:hash';
    const gen0 = idempotentTaskId(naturalKey, 0);
    const gen1 = idempotentTaskId(naturalKey, 1);
    const db = new ExpiryAwareTaskDb();
    db.rows.set(gen0, taskRow(gen0, 'completed'));
    db.expiredIds.add(gen0);
    db.rows.set(gen1, taskRow(gen1, 'completed'));
    const store = new PostgresTaskStore(db);

    await expect(getIdempotentTask(store, naturalKey))
      .resolves.toMatchObject({ taskId: gen1, status: 'completed' });
    await expect(createOrReuseIdempotentTask(store, naturalKey, 60_000, request))
      .resolves.toMatchObject({ taskId: gen1, status: 'completed' });
    expect(db.insertedIds).toEqual([]);
  });

  it('skips an expired uncleaned primary key when creating a replacement', async () => {
    const naturalKey = 'principal\0get_products\0success:other-key:other-hash';
    const gen0 = idempotentTaskId(naturalKey, 0);
    const gen1 = idempotentTaskId(naturalKey, 1);
    const db = new ExpiryAwareTaskDb();
    db.rows.set(gen0, taskRow(gen0, 'completed'));
    db.expiredIds.add(gen0);
    const store = new PostgresTaskStore(db);

    await expect(createOrReuseIdempotentTask(store, naturalKey, 60_000, request))
      .resolves.toMatchObject({ taskId: gen1, status: 'working' });
    expect(db.insertedIds).toEqual([gen1]);
  });
});
