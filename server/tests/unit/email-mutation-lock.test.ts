import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), poolQuery: vi.fn(), release: vi.fn(), connect: vi.fn(), log: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ getPool: () => ({ connect: mocks.connect, query: mocks.poolQuery }), getDedicatedClient: vi.fn() }));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ error: mocks.log, warn: mocks.log, info: mocks.log }) }));
vi.mock('../../src/auth/workos-client.js', () => ({ getEmailMutationWorkos: vi.fn() }));
import { setPrimaryEmail } from '../../src/services/email-mutation.js';
const operationId = '9f49dcb7-c1d6-48b9-9a55-c14339f7e63e';
const attempt = () => setPrimaryEmail({ userId: 'user_test', operationId, email: 'old@test.example' }).catch(error => error);
const noRows = { rowCount: 0, rows: [] };
const userRow = { rowCount: 1, rows: [{ email: 'old@test.example', email_verified: false, email_mutation_version: '0' }] };

describe('email mutation lock and request validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('FROM email_mutations')) return noRows;
      if (sql.includes('FROM users')) return userRow;
      throw new Error('Unexpected query');
    });
  });
  it('releases the connection only after positively acknowledging unlock and never nests pool checkout', async () => {
    expect(await attempt()).toMatchObject({ status: 400 });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false); expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
  it.each([false, undefined])('destroys the connection for unlock result %s', async unlocked => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: unlocked === undefined ? [] : [{ unlocked }] };
      return sql.includes('FROM users') ? userRow : noRows;
    });
    await attempt(); expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('destroys the connection on unlock failure without logging raw diagnostics', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('secret diagnostic');
      return sql.includes('FROM users') ? userRow : noRows;
    });
    await attempt(); expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('secret');
  });
  it('destroys a connection whose lock acquisition response is lost', async () => {
    mocks.query.mockRejectedValueOnce(new Error('acquisition response lost'));
    await attempt(); expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('reports busy as retryable without a nonexistent reconciliation operation', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
    const error = await attempt();
    expect(error).toMatchObject({ status: 409, body: { error: 'credential_busy', retryable: true } });
    expect(error.body).not.toHaveProperty('reconciliation_required'); expect(error.body).not.toHaveProperty('operation_id');
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false); expect(mocks.query).toHaveBeenCalledOnce();
  });
  it('destroys a connection with unproven lock ownership', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }); await attempt(); expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([undefined, null, {}, '', ' ', 'not-an-email', '@test.example', 'a@b@c.example', 'a@.example', 'a@test.', 'a @test.example', `${'a'.repeat(256)}@test.example`])('rejects malformed email %j before database work', async email => {
    await expect(setPrimaryEmail({ userId: 'user_test', operationId, email })).rejects.toMatchObject({ status: 400 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, '', 'request-1', '9f49dcb7-c1d6-48b9-9a55-c14339f7e63z'])('requires a caller UUID (%j)', async id => {
    await expect(setPrimaryEmail({ userId: 'user_test', operationId: id, email: 'new@test.example' })).rejects.toMatchObject({ status: 400 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
