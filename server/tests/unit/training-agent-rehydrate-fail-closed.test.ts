/**
 * account.stable_account_id: when an account_id is not in process memory and
 * the durable binding read fails, rehydration must fail closed. Continuing
 * would key the id to its opaque partition, stranding writes where later
 * natural-partition reads never see them.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/training-agent/reporting-reliability.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/training-agent/reporting-reliability.js')>();
  return {
    ...actual,
    resolveReportingAccountDurably: vi.fn(async () => {
      throw new Error('connection terminated');
    }),
  };
});

const { clearAccountStore, rehydrateAccountById } = await import('../../src/training-agent/account-handlers.js');

describe('rehydrateAccountById', () => {
  it('fails closed with a transient SERVICE_UNAVAILABLE when the durable read throws', async () => {
    clearAccountStore();
    await expect(rehydrateAccountById('static:test', 'acct_not_in_memory')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      recovery: 'transient',
    });
  });
});
