import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/encryption.js', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  deriveKey: vi.fn(),
}));

import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { query, getClient } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);
const mockedGetClient = vi.mocked(getClient);

const EMPTY = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

function makeTransactionClient(queryResponses: Array<{ rows: any[] }>) {
  const calls: string[] = [];
  let idx = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(typeof sql === 'string' ? sql.trim().split(/\s+/)[0] : sql);
      const resp = queryResponses[idx] ?? EMPTY;
      idx++;
      return { ...EMPTY, ...resp };
    }),
    release: vi.fn(),
    _calls: calls,
  };
  return client;
}

const AGENT_URL = 'https://agent.example.com';

function makeRunRow(triggeredBy: string) {
  return {
    id: 'run-001',
    agent_url: AGENT_URL,
    lifecycle_stage: 'production',
    overall_status: 'passing',
    headline: null,
    total_duration_ms: 100,
    tested_at: new Date(),
    tracks_json: [],
    tracks_passed: 1,
    tracks_failed: 0,
    tracks_skipped: 0,
    tracks_partial: 0,
    agent_profile_json: null,
    observations_json: null,
    triggered_by: triggeredBy,
    dry_run: false,
  };
}

const minimalInput = (triggeredBy: 'heartbeat' | 'owner_test') => ({
  agent_url: AGENT_URL,
  lifecycle_stage: 'production' as const,
  overall_status: 'passing' as const,
  tracks_json: [{ track: 'core', status: 'pass' as const, scenario_count: 1, passed_count: 1, duration_ms: 100 }],
  tracks_passed: 1,
  tracks_failed: 0,
  tracks_skipped: 0,
  tracks_partial: 0,
  triggered_by: triggeredBy,
  dry_run: false,
});

describe('ComplianceDatabase — last-write-wins on agent_compliance_status', () => {
  let db: ComplianceDatabase;

  beforeEach(() => {
    db = new ComplianceDatabase();
    vi.clearAllMocks();
  });

  /**
   * Contract: agent_compliance_status uses ON CONFLICT DO UPDATE (not DO NOTHING).
   * Every recordComplianceRun call — regardless of triggered_by — overwrites the
   * materialized status row. A future change to "pick highest-priority source" or
   * "first-write-wins" would break this test.
   */
  it('always upserts status regardless of triggered_by — last-write-wins', async () => {
    const statusRow = { rows: [{ status: 'passing', previous_status: null }] };

    const client = makeTransactionClient([
      EMPTY,            // BEGIN
      { rows: [makeRunRow('heartbeat')] },  // INSERT agent_compliance_runs
      statusRow,        // UPSERT agent_compliance_status
      EMPTY,            // COMMIT
    ]);
    mockedGetClient.mockResolvedValueOnce(client as any);

    await db.recordComplianceRun(minimalInput('heartbeat'));

    const upsertCall = client.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('ON CONFLICT (agent_url) DO UPDATE'),
    );
    expect(upsertCall).toBeDefined();
  });

  it('owner_test write at T+1 wins over prior heartbeat — triggered_by is forwarded verbatim', async () => {
    const statusRow = { rows: [{ status: 'passing', previous_status: 'passing' }] };

    const client1 = makeTransactionClient([
      EMPTY,
      { rows: [makeRunRow('heartbeat')] },
      statusRow,
      EMPTY,
    ]);
    mockedGetClient.mockResolvedValueOnce(client1 as any);
    await db.recordComplianceRun(minimalInput('heartbeat'));

    const heartbeatRunInsert = client1.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO agent_compliance_runs'),
    );
    expect(heartbeatRunInsert).toBeDefined();
    expect(heartbeatRunInsert![1]).toContain('heartbeat');

    const client2 = makeTransactionClient([
      EMPTY,
      { rows: [makeRunRow('owner_test')] },
      statusRow,
      EMPTY,
    ]);
    mockedGetClient.mockResolvedValueOnce(client2 as any);
    await db.recordComplianceRun(minimalInput('owner_test'));

    const ownerTestRunInsert = client2.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO agent_compliance_runs'),
    );
    expect(ownerTestRunInsert).toBeDefined();
    expect(ownerTestRunInsert![1]).toContain('owner_test');

    const ownerTestUpsert = client2.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('ON CONFLICT (agent_url) DO UPDATE'),
    );
    expect(ownerTestUpsert).toBeDefined();
  });

  it('heartbeat at T+3 wins over prior owner_test at T+2 — no source-priority filtering', async () => {
    const statusRow = { rows: [{ status: 'passing', previous_status: 'passing' }] };

    const client = makeTransactionClient([
      EMPTY,
      { rows: [makeRunRow('heartbeat')] },
      statusRow,
      EMPTY,
    ]);
    mockedGetClient.mockResolvedValueOnce(client as any);
    await db.recordComplianceRun(minimalInput('heartbeat'));

    const runInsert = client.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO agent_compliance_runs'),
    );
    expect(runInsert![1]).toContain('heartbeat');

    const upsert = client.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('ON CONFLICT (agent_url) DO UPDATE'),
    );
    expect(upsert).toBeDefined();
  });

  it('getComplianceStatus LATERAL join returns last_triggered_by from most recent non-dry run', async () => {
    const now = new Date();
    mockedQuery.mockResolvedValueOnce({
      rows: [{
        agent_url: AGENT_URL,
        status: 'passing',
        lifecycle_stage: 'production',
        last_checked_at: now,
        last_passed_at: now,
        last_failed_at: null,
        streak_days: 1,
        streak_started_at: now,
        tracks_summary_json: { core: 'pass' },
        headline: null,
        previous_status: null,
        status_changed_at: null,
        updated_at: now,
        last_run_id: 'run-owner-test',
        last_triggered_by: 'owner_test',
      }],
      rowCount: 1,
      command: '',
      oid: 0,
      fields: [],
    });

    const status = await db.getComplianceStatus(AGENT_URL);

    expect(status).not.toBeNull();
    expect(status!.last_run_id).toBe('run-owner-test');
    expect(status!.last_triggered_by).toBe('owner_test');

    const [sql] = mockedQuery.mock.calls[0];
    expect(sql).toContain('r.id AS last_run_id');
    expect(sql).toContain('dry_run = false');
    expect(sql).toContain('ORDER BY tested_at DESC');
    expect(sql).toContain('LIMIT 1');
  });

  it('getStoryboardStatusCounts can scope counts to the latest compliance run id', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ passing: '0', total: '0' }],
      rowCount: 1,
      command: '',
      oid: 0,
      fields: [],
    });

    const counts = await db.getStoryboardStatusCounts(AGENT_URL, { runId: 'run-new-empty' });

    expect(counts).toEqual({ passing: 0, total: 0 });
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('run_id::text = $2');
    expect(params).toEqual([AGENT_URL, 'run-new-empty', null]);
  });

  it('getStoryboardStatuses can scope storyboard detail to a single compliance run id', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: '',
      oid: 0,
      fields: [],
    });

    const statuses = await db.getStoryboardStatuses(AGENT_URL, { runId: 'run-new-empty' });

    expect(statuses).toEqual([]);
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('run_id::text = $2');
    expect(params).toEqual([AGENT_URL, 'run-new-empty', null]);
  });

  it('getStoryboardStatusCounts can suppress stale rows when the latest run wrote no storyboard rows', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ passing: '0', total: '0' }],
      rowCount: 1,
      command: '',
      oid: 0,
      fields: [],
    });

    const counts = await db.getStoryboardStatusCounts(AGENT_URL, { requireRowsForRunId: 'run-new-empty' });

    expect(counts).toEqual({ passing: 0, total: 0 });
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('latest.run_id::text = $3');
    expect(params).toEqual([AGENT_URL, null, 'run-new-empty']);
  });

  it('getStoryboardStatuses can preserve merged rows only when the latest run wrote storyboard rows', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: '',
      oid: 0,
      fields: [],
    });

    const statuses = await db.getStoryboardStatuses(AGENT_URL, { requireRowsForRunId: 'run-new-empty' });

    expect(statuses).toEqual([]);
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('latest.run_id::text = $3');
    expect(params).toEqual([AGENT_URL, null, 'run-new-empty']);
  });

  it('bulkGetStoryboardStatuses preserves merged rows unless the latest run explicitly wrote none', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: '',
      oid: 0,
      fields: [],
    });

    const statuses = await db.bulkGetStoryboardStatuses([AGENT_URL]);

    expect(statuses).toEqual(new Map());
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('WITH latest_runs AS');
    expect(sql).toContain('AND dry_run = false');
    expect(sql).toContain('latest_run_flags AS');
    expect(sql).toContain('latest.run_id = lr.id');
    expect(sql).toContain('COALESCE(lf.has_rows, true) = true');
    expect(params).toEqual([[AGENT_URL]]);
  });
});
