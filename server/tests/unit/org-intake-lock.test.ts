/**
 * Tests for the per-org Postgres advisory-lock helper that serializes
 * billing intakes (invoice-request, invite-accept) to close the millisecond
 * race the security review of #3171 flagged.
 *
 * The helper takes a transaction-scoped advisory lock keyed on
 * hashtext(orgId), runs the provided callback inside the transaction, and
 * commits on success / rolls back on error. The lock auto-releases at
 * transaction end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();
const mockClientRelease = vi.fn<() => void>();
const mockPoolConnect = vi.fn<() => Promise<{ query: typeof mockClientQuery; release: typeof mockClientRelease }>>();

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ connect: mockPoolConnect }),
}));

const { withOrgIntakeLock } = await import('../../src/billing/org-intake-lock.js');

beforeEach(() => {
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockReset();
  mockPoolConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
  mockClientQuery.mockResolvedValue({ rows: [] });
});

describe('withOrgIntakeLock', () => {
  it('takes a transaction, advisory-locks on hashtext(orgId), runs fn, commits, releases the connection', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withOrgIntakeLock('org_test_123', fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();

    // Calls must be in order: BEGIN → lock → (fn) → COMMIT
    const calls = mockClientQuery.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(mockClientQuery.mock.calls[1][1]).toEqual(['org_test_123']);
    expect(calls[2]).toBe('COMMIT');
    expect(mockClientRelease).toHaveBeenCalledOnce();
  });

  it('rolls back and re-throws when fn throws', async () => {
    const err = new Error('Stripe API down');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withOrgIntakeLock('org_x', fn)).rejects.toThrow('Stripe API down');

    const calls = mockClientQuery.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'ROLLBACK',
    ]);
    expect(mockClientRelease).toHaveBeenCalledOnce();
  });

  it('rolls back and re-throws when the lock query itself fails', async () => {
    const err = new Error('serialization failure');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(err);          // pg_advisory_xact_lock

    const fn = vi.fn();

    await expect(withOrgIntakeLock('org_x', fn)).rejects.toThrow('serialization failure');

    expect(fn).not.toHaveBeenCalled();
    const calls = mockClientQuery.mock.calls.map((c) => c[0]);
    // BEGIN ran, lock query failed, then ROLLBACK best-effort
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(calls[2]).toBe('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledOnce();
  });

  it('still releases the connection when ROLLBACK itself fails', async () => {
    const fnErr = new Error('Stripe rejected');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockRejectedValueOnce(new Error('rollback failed')); // ROLLBACK

    const fn = vi.fn().mockRejectedValue(fnErr);

    // Original fn error is preserved; rollback failure is swallowed.
    await expect(withOrgIntakeLock('org_x', fn)).rejects.toThrow('Stripe rejected');

    expect(mockClientRelease).toHaveBeenCalledOnce();
  });

  it('returns the typed result from fn', async () => {
    interface Outcome { kind: 'success'; id: string }
    const fn = vi.fn<() => Promise<Outcome>>().mockResolvedValue({ kind: 'success', id: 'inv_123' });

    const result = await withOrgIntakeLock<Outcome>('org_x', fn);

    expect(result).toEqual({ kind: 'success', id: 'inv_123' });
  });
});
