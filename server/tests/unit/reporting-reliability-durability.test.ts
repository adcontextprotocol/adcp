import { beforeEach, describe, expect, it, vi } from 'vitest';

let storedLedger: unknown;
let storedAccountScope: string | undefined;
let storedAccountRef: unknown;
let storedAccountState: unknown;
let failLedgerWrite = false;
const statements: string[] = [];
const client = {
  async query(text: string, values?: unknown[]) {
    statements.push(text);
    if (text.includes('SELECT ledger')) {
      return { rows: storedLedger === undefined ? [] : [{
        ledger: structuredClone(storedLedger),
        account_state: structuredClone(storedAccountState),
      }] };
    }
    if (text.includes('SELECT account_id, account_ref')) {
      return storedAccountRef === undefined
        ? { rows: [] }
        : { rows: [{
            account_id: 'acc_durable',
            account_ref: structuredClone(storedAccountRef),
            account_state: structuredClone(storedAccountState),
          }] };
    }
    if (text.includes('INSERT INTO training_reporting_ledgers')) {
      if (failLedgerWrite) throw new Error('injected ledger write failure');
      storedLedger = JSON.parse(values?.[2] as string) as unknown;
      if (typeof values?.[3] === 'string') storedAccountScope = values[3];
      if (typeof values?.[4] === 'string') storedAccountRef = JSON.parse(values[4]) as unknown;
      if (typeof values?.[5] === 'string') storedAccountState = JSON.parse(values[5]) as unknown;
    }
    return { rows: [] };
  },
  release() {},
};

vi.mock('../../src/db/client.js', () => ({
  isDatabaseInitialized: () => true,
  getPool: () => ({ connect: async () => client, query: client.query.bind(client) }),
}));

const reporting = await import('../../src/training-agent/reporting-reliability.js');
const accountHandlers = await import('../../src/training-agent/account-handlers.js');

describe('durable training reporting ledger', () => {
  beforeEach(() => {
    storedLedger = undefined;
    storedAccountScope = undefined;
    storedAccountRef = undefined;
    storedAccountState = undefined;
    failLedgerWrite = false;
    statements.length = 0;
    reporting.clearReportingReliabilityStore();
    accountHandlers.clearAccountStore();
  });

  it('restores the exact obligation denominator and immutable revision after a process-cache loss', async () => {
    const account = {
      brand: { domain: 'durable-reporting.example' },
      operator: 'seller.example',
      sandbox: true,
    };
    await reporting.withDurableReportingLedger('buyer:durable', 'acc_durable', true, () => {
      reporting.prepareReportingCoreLifecycleProbe('buyer:durable', 'acc_durable');
      reporting.setReportingMediaBuyCandidates('buyer:durable', 'acc_durable', [{
        mediaBuyId: 'mb_frozen',
        startTime: '2026-08-01T00:00:00.000Z',
        endTime: '2026-08-01T02:00:00.000Z',
        knownAt: '2026-08-01T00:30:00.000Z',
      }]);
      reporting.publishZeroRowReportingCoreLifecycleProbe('buyer:durable', 'acc_durable');
    }, account);

    reporting.clearReportingReliabilityStore();
    await expect(reporting.resolveReportingAccountDurably('buyer:durable', account)).resolves.toEqual({
      accountId: 'acc_durable',
      account,
    });
    expect(storedAccountScope).toContain('durable-reporting.example');
    const restored = await reporting.getReportingStatusForAccountDurably({
      account: { account_id: 'acc_durable' },
      view: 'periods',
    }, 'buyer:durable', 'acc_durable', []);

    expect(restored).toMatchObject({
      status: 'completed',
      periods: [expect.objectContaining({ media_buy_ids: ['mb_frozen'], revision_count: 1 })],
      revisions: [expect.objectContaining({ row_count: 0 })],
    });
    expect(statements.some(statement => statement.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.filter(statement => statement.includes('INSERT INTO training_reporting_ledgers'))).toHaveLength(2);

    const firstPage = await reporting.getReportingStatusForAccountDurably({
      account: { account_id: 'acc_durable' },
      view: 'periods',
      pagination: { max_results: 1 },
    }, 'buyer:durable', 'acc_durable', []);
    expect(firstPage.pagination?.has_more).toBe(true);
    reporting.clearReportingReliabilityStore();
    const secondPage = await reporting.getReportingStatusForAccountDurably({
      account: { account_id: 'acc_durable' },
      view: 'periods',
      pagination: { max_results: 1, cursor: firstPage.pagination?.cursor },
    }, 'buyer:durable', 'acc_durable', []);
    expect(secondPage.ledger_snapshot_id).toBe(firstPage.ledger_snapshot_id);
    expect(secondPage.revisions).toHaveLength(1);
    expect((storedLedger as { page_snapshots?: unknown[] }).page_snapshots).toHaveLength(1);
    expect((storedLedger as { page_cursors?: Array<[string, Record<string, unknown>]> }).page_cursors
      ?.every(([, cursor]) => cursor.resources === undefined && typeof cursor.snapshotId === 'string')).toBe(true);
  });

  it('does not publish an account binding when the ledger transaction fails', async () => {
    const account = {
      brand: { domain: 'failed-reporting.example' },
      operator: 'seller.example',
      sandbox: true,
    };
    failLedgerWrite = true;
    await expect(reporting.withDurableReportingLedger(
      'buyer:failed',
      'acc_failed',
      true,
      () => undefined,
      account,
    )).rejects.toThrow('injected ledger write failure');
    failLedgerWrite = false;
    await expect(reporting.resolveReportingAccountDurably('buyer:failed', account)).resolves.toBeUndefined();
  });

  it('projects durable reporting state only for accounts on the requested page', async () => {
    const listed = await accountHandlers.handleListAccounts({
      sandbox: true,
      pagination: { max_results: 1 },
    }, { mode: 'open', principal: 'buyer:page' });

    expect(listed).toMatchObject({
      accounts: [expect.objectContaining({ reporting_delivery_configs: [] })],
      pagination: { has_more: true },
    });
    expect(statements.filter(statement => statement.includes('SELECT ledger'))).toHaveLength(1);
    expect(statements.filter(statement => statement.includes('pg_advisory_xact_lock'))).toHaveLength(1);
  });

  it('reuses durable account identity for opaque updates and natural resync after cache loss', async () => {
    const account = {
      brand: { domain: 'durable-resync.example' },
      operator: 'seller.example',
      sandbox: true,
    };
    await reporting.bindReportingAccountDurably('buyer:resync', 'acc_durable', account, {
      changeScopeId: 'change:durable',
      accountId: 'acc_durable',
      brand: account.brand,
      operator: account.operator,
      billing: 'agent',
      paymentTerms: 'net_45',
      status: 'active',
      accountScope: 'operator_brand',
      sandbox: true,
      rateCard: 'sandbox',
      governanceAgents: [],
      notificationConfigs: [{
        subscriberId: 'reporting-ops',
        url: 'https://buyer.example/reporting',
        eventTypes: ['reporting.status_changed'],
        authentication: { schemes: ['Bearer'], credentials: 'write-only-secret' },
        active: true,
      }],
      syncedAt: '2026-08-01T00:00:00.000Z',
    });
    await reporting.captureReportingMediaBuyCandidateDurably(
      'buyer:resync',
      'acc_durable',
      { account_id: 'acc_durable' },
      {
        mediaBuyId: 'mb_cache_preservation',
        startTime: '2026-08-01T00:00:00.000Z',
        endTime: '2026-08-02T00:00:00.000Z',
        knownAt: '2026-08-01T00:00:00.000Z',
      },
    );
    await expect(reporting.resolveReportingAccountDurably('buyer:resync', account)).resolves.toMatchObject({
      accountId: 'acc_durable',
      accountState: { billing: 'agent', paymentTerms: 'net_45' },
    });
    reporting.clearReportingReliabilityStore();
    accountHandlers.clearAccountStore();

    const context = { mode: 'open' as const, principal: 'buyer:resync' };
    const opaque = await accountHandlers.handleSyncAccounts({
      dry_run: true,
      accounts: [{ account: { account_id: 'acc_durable' }, payment_terms: 'net_60' }],
    }, context);
    expect(opaque).toMatchObject({
      accounts: [expect.objectContaining({
        account_id: 'acc_durable',
        action: 'updated',
        billing: 'agent',
      })],
    });

    reporting.clearReportingReliabilityStore();
    accountHandlers.clearAccountStore();
    const natural = await accountHandlers.handleSyncAccounts({
      dry_run: true,
      accounts: [{ ...account, billing: 'operator' }],
    }, context);
    expect(natural).toMatchObject({
      accounts: [expect.objectContaining({ account_id: 'acc_durable', action: 'updated' })],
    });

    reporting.clearReportingReliabilityStore();
    accountHandlers.clearAccountStore();
    const listed = await accountHandlers.handleListAccounts({}, context);
    expect(listed).toMatchObject({
      accounts: [expect.objectContaining({
        account_id: 'acc_durable',
        billing: 'agent',
        payment_terms: 'net_45',
        notification_configs: [{
          subscriber_id: 'reporting-ops',
          url: 'https://buyer.example/reporting',
          event_types: ['reporting.status_changed'],
          authentication: { schemes: ['Bearer'] },
          active: true,
        }],
      })],
    });
  });
});
