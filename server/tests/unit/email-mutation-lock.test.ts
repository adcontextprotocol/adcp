import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), poolQuery: vi.fn(), release: vi.fn(), connect: vi.fn(), log: vi.fn(), getUser: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ connect: mocks.connect, query: mocks.poolQuery }),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ error: mocks.log, warn: mocks.log, info: mocks.log }) }));
vi.mock('../../src/auth/workos-client.js', () => ({
  getEmailMutationWorkos: () => ({ userManagement: { getUser: mocks.getUser } }),
}));
import { setPrimaryEmail } from '../../src/services/email-mutation.js';

describe('email mutation advisory lock cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.getUser.mockResolvedValue({ id: 'user_test', email: 'old@test.example', emailVerified: false });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('FROM email_mutations')) return { rows: [] };
      if (sql.includes('SELECT email, email_verified FROM users')) return { rows: [{ email: 'old@test.example', email_verified: false }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it('returns the session to the pool only after a positive unlock result', async () => {
    await setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.poolQuery).not.toHaveBeenCalled(); // No nested pool checkout while holding a client.
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each([
    ['false', { rows: [{ unlocked: false }] }],
    ['missing', { rows: [] }],
  ])('destroys the connection when unlock is %s', async (_name, result) => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return result;
      if (sql.includes('FROM email_mutations')) return { rows: [] };
      return { rows: [{ email: 'old@test.example', email_verified: false }] };
    });
    await setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.log).toHaveBeenCalledWith({ userId: 'user_test', code: 'advisory_unlock_failed' }, expect.any(String));
  });

  it('destroys the connection on unlock error without logging raw error contents', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('secret from provider');
      if (sql.includes('FROM email_mutations')) return { rows: [] };
      return { rows: [{ email: 'old@test.example', email_verified: false }] };
    });
    await setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('secret');
  });

  it('destroys the connection if the lock acquisition response is lost', async () => {
    mocks.query.mockRejectedValueOnce(new Error('connection lost after lock acquisition'));
    await expect(setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' })).rejects.toThrow('connection lost');
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not unlock another request when the lock is busy', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
    await expect(setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' })).rejects.toMatchObject({
      status: 409, body: { reconciliation_required: true },
    });
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('destroys the connection when lock ownership is missing from the response', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' })).rejects.toMatchObject({ status: 409 });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not expose provider secrets after an already-primary read failure', async () => {
    mocks.getUser.mockRejectedValueOnce(new Error('secret provider token'));
    const error = await setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' }).catch(error => error);
    expect(error).toMatchObject({ status: 503 });
    expect(error.message).not.toContain('secret');
    expect(JSON.stringify(error.body)).not.toContain('secret');
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('secret');
  });

  it('does not log raw provider records when an already-primary read disagrees', async () => {
    mocks.getUser.mockResolvedValueOnce({
      id: 'different_user', email: 'old@test.example', emailVerified: false, diagnostic: 'secret provider token',
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('FROM users')) return { rows: [{ email: 'old@test.example', email_verified: false }] };
      return { rows: [] };
    });
    const error = await setPrimaryEmail({ userId: 'user_test', email: 'old@test.example' }).catch(error => error);
    expect(error).toMatchObject({ status: 409, body: { reconciliation_required: true } });
    expect(JSON.stringify(error.body)).not.toContain('secret');
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('secret');
  });

  it.each([undefined, null, {}, '', ' ', 'not-an-email', '@test.example', 'a@b@c.example', 'a@.example', 'a@test.', 'a @test.example', `${'a'.repeat(256)}@test.example`])('rejects malformed email %j before provider or database work', async email => {
    await expect(setPrimaryEmail({ userId: 'user_test', email })).rejects.toMatchObject({ status: 400 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
