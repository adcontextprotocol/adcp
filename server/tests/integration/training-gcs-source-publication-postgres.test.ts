/** Actual PostgreSQL source commits; controlled delivery inputs, no GCS qualification. */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const shared = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('../../src/db/client.js', () => ({ isDatabaseInitialized: () => !!shared.pool, getPool: () => shared.pool }));
const reporting = await import('../../src/training-agent/reporting-reliability.js');
const { committedTrainingRevisionFetch } = await import('../../src/training-agent/gcs-reporting-source.js');
const testUrl = process.env.TRAINING_GCS_SOURCE_TEST_DATABASE_URL;
const principal = 'workos:source-test';
const accountId = 'source-account';
const mediaBuyIds = ['source-buy'];
const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const period = { start: new Date(today - 86_400_000).toISOString(), end: new Date(today).toISOString() };
const offering = reporting.TRAINING_REPORTING_MANAGED_OFFERING;
const config = { delivery_config_id: 'daily-source', delivery_config_version: 1, offering_id: offering.offering_id, active: true,
  feed_purpose: offering.feed_purpose, report_definition_id: offering.report_definition_id, reporting_profile: offering.reporting_profile.id,
  scope: { media_buy_ids: mediaBuyIds }, coverage_requirement: 'full', required_finality: offering.supported_finality[0],
  reconciliation_mode: offering.reconciliation_mode, schedule: offering.schedule,
  method: { pattern: offering.method.pattern, transport: offering.method.transport, orchestration: offering.method.orchestration,
    destination: { mode: 'provision', provider: offering.method.provider, access_mode: offering.method.access_mode, recipient: { identity: 'source-reader' } } } };
const input = { principal, accountId, sourceConfigId: config.delivery_config_id, sourceConfigVersion: 1, mediaBuyIds, period, impressions: 123 };

describe.skipIf(!testUrl)('ordinary closed-day source publication on PostgreSQL', () => {
  beforeAll(async () => {
    if (new URL(testUrl!).pathname !== '/training_gcs_source_tests') throw new Error('Requires dedicated disposable source database.');
    shared.pool = new Pool({ connectionString: testUrl, max: 3, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=10000 -c lock_timeout=3000' });
    const migration = await readFile(new URL('../../src/db/migrations/575_reporting_reliability_curriculum.sql', import.meta.url), 'utf8');
    await shared.pool.query(migration.split('\nUPDATE certification_modules')[0]);
  });
  afterAll(async () => { await shared.pool?.end(); shared.pool = undefined; });
  beforeEach(async () => {
    reporting.clearReportingReliabilityStore();
    await shared.pool!.query('TRUNCATE training_reporting_ledgers');
    await reporting.withDurableReportingLedger(principal, accountId, true, () => {
      reporting.replaceReportingConfigurations(principal, accountId, [config], new Date(today - 2 * 86_400_000).toISOString());
      reporting.setReportingMediaBuyCandidates(principal, accountId, [{ mediaBuyId: mediaBuyIds[0],
        startTime: new Date(today - 3 * 86_400_000).toISOString(), endTime: new Date(today + 86_400_000).toISOString(),
        knownAt: new Date(today - 3 * 86_400_000).toISOString() }]);
    }, { account_id: accountId }, { currency: 'USD' });
  });
  it('makes unseeded ordinary source rows readable by the actual committed-revision adapter', async () => {
    expect(await reporting.commitTrainingDailySourcePeriod(input)).toBe(true);
    const response = await committedTrainingRevisionFetch(shared.pool!)(
      { account: { account_id: accountId }, media_buy_ids: mediaBuyIds, constituents: [{ constituent_id: 'buy', media_buy_id: mediaBuyIds[0] }],
        start_date: period.start, end_date: period.end, source_read_cutoff_at: period.end, requested_metrics: ['impressions'], reporting_dimensions: {} },
      { signal: new AbortController().signal, sourceScope: { principal_id: principal, source_config_id: config.delivery_config_id, source_config_version: 1 },
        sourceSettings: { currency: 'USD' } } as never,
    );
    expect(response).toMatchObject({ reporting_period: period, reporting_rows: [{ period_start: period.start, period_end: period.end, impressions: 123 }] });
  });
  it('preserves the first immutable bytes through concurrent reads and process-cache loss', async () => {
    expect(await reporting.commitTrainingDailySourcePeriod(input)).toBe(true);
    const before = (await shared.pool!.query('SELECT ledger FROM training_reporting_ledgers')).rows[0].ledger.revision_contents;
    reporting.clearReportingReliabilityStore();
    expect(await Promise.all([reporting.commitTrainingDailySourcePeriod({ ...input, impressions: 456 }), reporting.commitTrainingDailySourcePeriod(input)])).toEqual([true, true]);
    expect((await shared.pool!.query('SELECT ledger FROM training_reporting_ledgers')).rows[0].ledger.revision_contents).toEqual(before);
  });
  it('refuses conformance clock fixtures as live source evidence', async () => {
    await reporting.withDurableReportingLedger(principal, accountId, true, () => {
      reporting.setReportingCoreLifecycleProbeClock(principal, accountId, period.end);
    });
    expect(await reporting.commitTrainingDailySourcePeriod(input)).toBe(false);
    expect((await shared.pool!.query('SELECT ledger FROM training_reporting_ledgers')).rows[0].ledger.revision_contents).toEqual([]);
  });
  it.each([
    ['open day', { ...input, period: { start: period.end, end: new Date(today + 86_400_000).toISOString() } }],
    ['partial day', { ...input, period: { ...period, start: new Date(today - 43_200_000).toISOString() } }],
    ['predates activation', { ...input, period: { start: new Date(today - 4 * 86_400_000).toISOString(), end: new Date(today - 3 * 86_400_000).toISOString() } }],
    ['foreign account', { ...input, accountId: 'foreign' }],
    ['foreign principal', { ...input, principal: 'workos:foreign' }],
    ['wrong source version', { ...input, sourceConfigVersion: 2 }],
    ['incomplete scope', { ...input, mediaBuyIds: ['unknown-buy'] }],
    ['negative total', { ...input, impressions: -1 }],
  ])('does not mint a revision for %s', async (_name, candidate) => {
    expect(await reporting.commitTrainingDailySourcePeriod(candidate)).toBe(false);
    const ledgers = (await shared.pool!.query('SELECT ledger FROM training_reporting_ledgers')).rows;
    expect(ledgers.every(row => row.ledger.revision_contents.length === 0)).toBe(true);
  });
});
