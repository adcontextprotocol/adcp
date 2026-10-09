import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_LINK_CORRELATION_TTL_MS,
  consumeAccountLinkCorrelation,
  createAccountLinkCorrelation,
  isAccountLinkCorrelationToken,
  type AccountLinkSurface,
} from '../../src/db/addie-account-link-correlation-db.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const origins = [
  { surface: 'slack', userType: 'slack' },
  { surface: 'web', userType: 'workos' },
  { surface: 'web', userType: 'anonymous' },
] as const;

describe('account-link correlations with PostgreSQL', () => {
  let pool: Pool;
  const threadIds: string[] = [];

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL
        || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterEach(async () => {
    // Correlations cascade with their fixture thread; leave other tests' rows alone.
    if (threadIds.length > 0) {
      await pool.query('DELETE FROM addie_threads WHERE thread_id = ANY($1::uuid[])', [threadIds]);
      threadIds.length = 0;
    }
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function createThread(surface: AccountLinkSurface, userType: string) {
    const threadId = crypto.randomUUID();
    const initiatingUserId = `account-link-user-${crypto.randomUUID()}`;
    const externalId = `account-link-thread-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO addie_threads (thread_id, channel, user_type, user_id, external_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [threadId, surface, userType, initiatingUserId, externalId],
    );
    threadIds.push(threadId);
    return { surface, threadId, initiatingUserId, externalId };
  }

  async function createToken(input: Parameters<typeof createAccountLinkCorrelation>[0]) {
    const token = await createAccountLinkCorrelation(input);
    expect(isAccountLinkCorrelationToken(token)).toBe(true);
    if (!token) throw new Error('Expected a correlation token for the exact origin');
    return token;
  }

  it.each(origins)('creates $surface/$userType with only a hash and the existing TTL', async ({ surface, userType }) => {
    const origin = await createThread(surface, userType);
    const startedAt = Date.now();
    const token = await createToken(origin);
    const finishedAt = Date.now();
    const stored = await pool.query(
      `SELECT token_hash, surface, thread_id, initiating_user_id, external_id, expires_at, consumed_at
       FROM addie_account_link_correlations WHERE thread_id = $1`,
      [origin.threadId],
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      token_hash: crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
      surface,
      thread_id: origin.threadId,
      initiating_user_id: origin.initiatingUserId,
      external_id: origin.externalId,
      consumed_at: null,
    });
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(stored.rows[0].expires_at.getTime()).toBeGreaterThanOrEqual(startedAt + ACCOUNT_LINK_CORRELATION_TTL_MS);
    expect(stored.rows[0].expires_at.getTime()).toBeLessThanOrEqual(finishedAt + ACCOUNT_LINK_CORRELATION_TTL_MS);
  });

  it.each(origins)('requires the exact user, thread and channel for $surface/$userType creation', async ({ surface, userType }) => {
    const origin = await createThread(surface, userType);
    await expect(createAccountLinkCorrelation({
      ...origin, initiatingUserId: 'account-link-other-user',
    })).resolves.toBeUndefined();
    await expect(createAccountLinkCorrelation({
      ...origin, threadId: crypto.randomUUID(),
    })).resolves.toBeUndefined();
    await expect(createAccountLinkCorrelation({
      ...origin, surface: surface === 'slack' ? 'web' : 'slack',
    })).resolves.toBeUndefined();
    // Keep user_type valid for the claimed surface to isolate the channel check.
    await pool.query('UPDATE addie_threads SET channel = $1 WHERE thread_id = $2', [
      surface === 'slack' ? 'web' : 'slack', origin.threadId,
    ]);
    await expect(createAccountLinkCorrelation(origin)).resolves.toBeUndefined();
    await pool.query('UPDATE addie_threads SET channel = $1 WHERE thread_id = $2', [surface, origin.threadId]);

    const stored = await pool.query(
      'SELECT token_hash FROM addie_account_link_correlations WHERE thread_id = $1',
      [origin.threadId],
    );
    expect(stored.rows).toEqual([]);
    await createToken(origin);
  });

  it.each([
    { surface: 'slack', userType: 'workos' },
    { surface: 'slack', userType: 'anonymous' },
    { surface: 'web', userType: 'slack' },
    { surface: 'web', userType: 'agent' },
  ] as const)('refuses $surface creation for user type $userType', async ({ surface, userType }) => {
    const origin = await createThread(surface, userType);
    await expect(createAccountLinkCorrelation(origin)).resolves.toBeUndefined();
  });

  it.each(origins)('keeps concurrent $surface/$userType tokens independently valid and single-use', async ({ surface, userType }) => {
    const origin = await createThread(surface, userType);
    const tokens = await Promise.all([createToken(origin), createToken(origin)]);
    expect(new Set(tokens).size).toBe(2);
    const stored = await pool.query(
      'SELECT token_hash FROM addie_account_link_correlations WHERE thread_id = $1',
      [origin.threadId],
    );
    expect(stored.rows).toHaveLength(2);
    expect(new Set(stored.rows.map(row => row.token_hash)).size).toBe(2);

    const correlationIds = new Set<string>();
    for (const token of tokens) {
      await expect(consumeAccountLinkCorrelation(token, {
        surface, initiatingUserId: 'account-link-other-user',
      })).resolves.toBeUndefined();
      await expect(consumeAccountLinkCorrelation(token, {
        ...origin, surface: surface === 'slack' ? 'web' : 'slack',
      })).resolves.toBeUndefined();
      const consumed = await consumeAccountLinkCorrelation(token, origin);
      expect(consumed).toEqual({ ...origin, correlationId: expect.any(String) });
      correlationIds.add(consumed!.correlationId);
      await expect(consumeAccountLinkCorrelation(token, origin)).resolves.toBeUndefined();
    }
    expect(correlationIds.size).toBe(2);
  });

  it('allows only one winner when the exact principal consumes concurrently', async () => {
    const origin = await createThread('slack', 'slack');
    const token = await createToken(origin);
    const results = await Promise.all([
      consumeAccountLinkCorrelation(token, origin),
      consumeAccountLinkCorrelation(token, origin),
    ]);
    expect(results.filter(Boolean)).toEqual([{ ...origin, correlationId: expect.any(String) }]);
    expect(results.filter(result => result === undefined)).toHaveLength(1);
    await expect(consumeAccountLinkCorrelation(token, origin)).resolves.toBeUndefined();
  });

  it.each(origins)('refuses expired $surface/$userType tokens without consuming them', async ({ surface, userType }) => {
    const origin = await createThread(surface, userType);
    const token = await createToken(origin);
    await pool.query(
      `UPDATE addie_account_link_correlations SET expires_at = NOW() - INTERVAL '1 second'
       WHERE thread_id = $1`,
      [origin.threadId],
    );
    await expect(consumeAccountLinkCorrelation(token, origin)).resolves.toBeUndefined();
    const stored = await pool.query(
      'SELECT consumed_at FROM addie_account_link_correlations WHERE thread_id = $1',
      [origin.threadId],
    );
    expect(stored.rows).toEqual([{ consumed_at: null }]);
  });

  it.each(origins)('rechecks $surface/$userType thread identity at consumption', async ({ surface, userType }) => {
    const origin = await createThread(surface, userType);
    const token = await createToken(origin);
    const original = [surface, userType, origin.initiatingUserId, origin.externalId];
    const changed = [surface === 'slack' ? 'web' : 'slack', 'agent', 'account-link-other-user', 'account-link-other-thread'];
    for (let index = 0; index < original.length; index++) {
      const values = [...original];
      values[index] = changed[index];
      await pool.query(
        `UPDATE addie_threads SET channel = $1, user_type = $2, user_id = $3, external_id = $4
         WHERE thread_id = $5`,
        [...values, origin.threadId],
      );
      await expect(consumeAccountLinkCorrelation(token, origin)).resolves.toBeUndefined();
    }
    await pool.query(
      `UPDATE addie_threads SET channel = $1, user_type = $2, user_id = $3, external_id = $4
       WHERE thread_id = $5`,
      [...original, origin.threadId],
    );
    await expect(consumeAccountLinkCorrelation(token, origin)).resolves.toEqual({
      ...origin, correlationId: expect.any(String),
    });
  });
});
