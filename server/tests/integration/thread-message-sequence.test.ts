import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ThreadService } from '../../src/addie/thread-service.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

// Real PostgreSQL connections: the parent-row holder forces each writer to wait
// after the original implementation's MAX read. With the backport, only the
// first writer reaches INSERT; the others wait on the per-thread advisory lock.
describe.skipIf(!process.env.DATABASE_URL)('Thread message sequence transactions', () => {
  const workerName = `thread-sequence-${randomUUID()}`;
  let control: Pool;
  const threadIds: string[] = [];

  beforeAll(async () => {
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.searchParams.set('application_name', workerName);
    initializeDatabase({ connectionString: workerUrl.toString() });
    control = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=2000 -c lock_timeout=2000',
    });
    await runMigrations();
  });

  afterAll(async () => {
    try {
      if (control) {
        await control.query('DELETE FROM addie_threads WHERE thread_id = ANY($1::uuid[])', [threadIds]);
      }
    } finally {
      await closeDatabase();
      await control?.end();
    }
  });

  async function createThread() {
    const thread = await new ThreadService().getOrCreateThread({
      channel: 'web',
      external_id: `sequence-regression-${randomUUID()}`,
      user_type: 'anonymous',
    });
    threadIds.push(thread.thread_id);
    return thread.thread_id;
  }

  async function assertStored(threadId: string, numbers: number[]) {
    const stored = await control.query<{ message_id: string; sequence_number: number }>(
      'SELECT message_id, sequence_number FROM addie_thread_messages WHERE thread_id = $1 ORDER BY sequence_number',
      [threadId],
    );
    expect(stored.rows.map(message => message.sequence_number)).toEqual(numbers);
    expect(new Set(stored.rows.map(message => message.message_id)).size).toBe(numbers.length);
    const parent = await control.query<{ message_count: number }>(
      'SELECT message_count FROM addie_threads WHERE thread_id = $1', [threadId],
    );
    expect(parent.rows[0].message_count).toBe(numbers.length);
    return stored.rows;
  }

  async function waitForBlockedWriters(holderPid: number) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const waiting = await control.query<{ pid: number; blockers: number[] }>(
        `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'`, [workerName],
      );
      const pids = new Set(waiting.rows.map(row => row.pid));
      if (pids.size === 3 && waiting.rows.every(row =>
        row.blockers.length > 0 && row.blockers.every(pid => pid === holderPid || pids.has(pid)))) {
        return waiting.rows;
      }
      await delay(20);
    }
    throw new Error('Three independent PostgreSQL writers did not reach the held transaction within 2500ms');
  }

  for (const seeded of [false, true]) {
    it(`serializes three independent writers ${seeded ? 'after a seeded message' : 'on an empty thread'}`, async () => {
      const threadId = await createThread();
      if (seeded) {
        const seed = await new ThreadService().addMessage({ thread_id: threadId, role: 'user', content: 'Seed' });
        expect(seed.sequence_number).toBe(1);
      }
      const holder = await control.connect();
      let writes: ReturnType<ThreadService['addMessage']>[] = [];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT thread_id FROM addie_threads WHERE thread_id = $1 FOR UPDATE', [threadId]);
        const pid = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        writes = [1, 2, 3].map(number => new ThreadService().addMessage({
          thread_id: threadId, role: 'user', content: `Independent writer ${number}`,
        }));
        // Attach a handler immediately, including when fixture setup fails.
        const completed = Promise.all(writes);
        void completed.catch(() => {});
        const waiting = await waitForBlockedWriters(pid.rows[0].pid);
        expect(new Set(waiting.map(row => row.pid)).size).toBe(3);
        await holder.query('COMMIT');
        const messages = await completed;
        const expected = seeded ? [2, 3, 4] : [1, 2, 3];
        expect(messages.map(message => message.sequence_number).sort((a, b) => a - b)).toEqual(expected);
        expect(new Set(messages.map(message => message.message_id)).size).toBe(3);
        const stored = await assertStored(threadId, seeded ? [1, 2, 3, 4] : [1, 2, 3]);
        expect(messages.every(message => stored.some(row => row.message_id === message.message_id))).toBe(true);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await Promise.allSettled(writes);
      }
    });
  }

  it('rolls back a failed INSERT and releases the lock for an independent writer', async () => {
    const threadId = await createThread();
    await expect(new ThreadService().addMessage({
      thread_id: threadId,
      role: 'invalid-role' as 'user',
      content: 'Must fail the PostgreSQL role constraint',
    })).rejects.toMatchObject({ code: '23514' });
    await assertStored(threadId, []);
    const next = await new ThreadService().addMessage({ thread_id: threadId, role: 'user', content: 'After rollback' });
    expect(next.sequence_number).toBe(1);
    await assertStored(threadId, [1]);
  });

  it('refuses a held advisory lock within the production timeout and allows a later write', async () => {
    const threadId = await createThread();
    const holder: PoolClient = await control.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadId]);
      await expect(new ThreadService().addMessage({ thread_id: threadId, role: 'user', content: 'Blocked' }))
        .rejects.toMatchObject({ code: '55P03' });
      await assertStored(threadId, []);
      await holder.query('COMMIT');
      const next = await new ThreadService().addMessage({ thread_id: threadId, role: 'user', content: 'After timeout' });
      expect(next.sequence_number).toBe(1);
      await assertStored(threadId, [1]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('keeps the PostgreSQL foreign-key failure for a nonexistent thread', async () => {
    await expect(new ThreadService().addMessage({
      thread_id: randomUUID(), role: 'user', content: 'No parent thread',
    })).rejects.toMatchObject({ code: '23503' });
    const threadId = await createThread();
    const next = await new ThreadService().addMessage({ thread_id: threadId, role: 'user', content: 'Existing parent' });
    expect(next.sequence_number).toBe(1);
    await assertStored(threadId, [1]);
  });
});
