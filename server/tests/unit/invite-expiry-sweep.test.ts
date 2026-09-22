import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  getClient: vi.fn(),
  resolvePersonId: vi.fn(),
  recordInviteEvent: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/db/client.js', () => ({ getClient: mocks.getClient }));
vi.mock('../../src/db/relationship-db.js', () => ({ resolvePersonId: mocks.resolvePersonId }));
vi.mock('../../src/db/person-events-db.js', () => ({ recordInviteEvent: mocks.recordInviteEvent }));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ child: () => mocks.log }) }));

import { runInviteExpirySweep } from '../../src/addie/jobs/invite-expiry-sweep.js';

const emptyResult = { candidates: 0, emitted: 0, resolveFailures: 0, recordFailures: 0 };
const invite = {
  id: 'invite-1', token: 'test-token', workos_organization_id: 'org-1',
  lookup_key: 'membership', contact_email: 'invite@example.com',
  expires_at: new Date('2026-01-01T00:00:00Z'),
};

function acquiredWith(rows: unknown[]) {
  mocks.client.query
    .mockResolvedValueOnce({ rows: [{ acquired: true }] })
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [{ released: true }] });
}

function expectUnlocked() {
  const [lockSql, lockParams] = mocks.client.query.mock.calls[0];
  expect(lockSql).toContain('pg_try_advisory_lock');
  expect(mocks.client.query).toHaveBeenLastCalledWith(
    'SELECT pg_advisory_unlock($1) AS released', lockParams,
  );
  expect(mocks.client.release).toHaveBeenCalledExactlyOnceWith(false);
}

describe('invite expiry sweep concurrency guard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getClient.mockResolvedValue(mocks.client);
    mocks.resolvePersonId.mockResolvedValue('person-1');
    mocks.recordInviteEvent.mockResolvedValue(true);
  });

  it('skips before selecting or resolving candidates when the lock is held', async () => {
    mocks.client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    expect(await runInviteExpirySweep()).toEqual(emptyResult);
    expect(mocks.client.query).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePersonId).not.toHaveBeenCalled();
    expect(mocks.recordInviteEvent).not.toHaveBeenCalled();
    expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining('skipping'));
    expect(mocks.client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('unlocks and releases even when there are no candidates', async () => {
    acquiredWith([]);
    expect(await runInviteExpirySweep()).toEqual(emptyResult);
    expectUnlocked();
  });

  it('holds the lock until event recording finishes', async () => {
    acquiredWith([invite]);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    mocks.recordInviteEvent.mockImplementationOnce(async () => {
      entered();
      await gate;
      return true;
    });
    const sweep = runInviteExpirySweep();
    try {
      await started;
      expect(mocks.client.query).toHaveBeenCalledTimes(2);
      expect(mocks.client.release).not.toHaveBeenCalled();
    } finally {
      finish();
    }
    expect(await sweep).toEqual({ ...emptyResult, candidates: 1, emitted: 1 });
    expectUnlocked();
  });

  it('unlocks after a candidate query error and preserves the error', async () => {
    const error = new Error('candidate query failed');
    mocks.client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ rows: [{ released: true }] });
    await expect(runInviteExpirySweep()).rejects.toBe(error);
    expectUnlocked();
  });

  it.each(['resolve', 'record'])('unlocks after a per-invite %s failure', async (phase) => {
    acquiredWith([invite]);
    (phase === 'resolve' ? mocks.resolvePersonId : mocks.recordInviteEvent)
      .mockRejectedValueOnce(new Error('per-invite failure'));
    expect(await runInviteExpirySweep()).toEqual({
      ...emptyResult, candidates: 1,
      resolveFailures: phase === 'resolve' ? 1 : 0,
      recordFailures: phase === 'record' ? 1 : 0,
    });
    expectUnlocked();
  });

  it('destroys the session when lock acquisition has an uncertain outcome', async () => {
    const error = new Error('connection lost during acquisition');
    mocks.client.query.mockRejectedValueOnce(error);
    await expect(runInviteExpirySweep()).rejects.toBe(error);
    expect(mocks.client.query).toHaveBeenCalledTimes(1);
    expect(mocks.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['throws', 'returns false'])('destroys the session when unlock %s', async (mode) => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] });
    if (mode === 'throws') mocks.client.query.mockRejectedValueOnce(new Error('unlock failed'));
    else mocks.client.query.mockResolvedValueOnce({ rows: [{ released: false }] });
    expect(await runInviteExpirySweep()).toEqual(emptyResult);
    expect(mocks.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('preserves a sweep error when unlocking also fails', async () => {
    const error = new Error('candidate query failed');
    mocks.client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(new Error('unlock failed'));
    await expect(runInviteExpirySweep()).rejects.toBe(error);
    expect(mocks.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('propagates checkout failures without running any work', async () => {
    const error = new Error('pool unavailable');
    mocks.getClient.mockRejectedValueOnce(error);
    await expect(runInviteExpirySweep()).rejects.toBe(error);
    expect(mocks.client.query).not.toHaveBeenCalled();
    expect(mocks.resolvePersonId).not.toHaveBeenCalled();
  });
});
