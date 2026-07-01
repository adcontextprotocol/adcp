import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../src/utils/posthog.js', () => ({
  captureEvent: vi.fn(),
}));

import { insertTypeReclassification } from '../../src/db/type-reclassification-log-db.js';
import { query } from '../../src/db/client.js';
import { captureEvent } from '../../src/utils/posthog.js';

const mockedQuery = vi.mocked(query);
const mockedCaptureEvent = vi.mocked(captureEvent);

describe('insertTypeReclassification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as any);
  });

  it('writes all canonical columns when every field is provided', async () => {
    await insertTypeReclassification({
      agentUrl: 'https://bidcliq.example/agent',
      memberId: 'org_01ABCDEF',
      oldType: 'buying',
      newType: 'sales',
      source: 'backfill_script',
      runId: 'backfill-1714000000000',
      notes: { reason: 'agree_with_snapshot', stored_was: 'buying' },
    });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO type_reclassification_log/);
    expect(params).toEqual([
      'https://bidcliq.example/agent',
      'org_01ABCDEF',
      'buying',
      'sales',
      'backfill_script',
      'backfill-1714000000000',
      JSON.stringify({ reason: 'agree_with_snapshot', stored_was: 'buying' }),
    ]);
  });

  it('null-pads optional fields (member_id, old_type, run_id, notes) when omitted', async () => {
    // Crawler-side disagreement: no member context, no run_id, possibly no
    // old_type if first-classification.
    await insertTypeReclassification({
      agentUrl: 'https://swivel.example/agent',
      newType: 'sales',
      source: 'crawler_promote',
    });

    const [, params] = mockedQuery.mock.calls[0];
    expect(params).toEqual([
      'https://swivel.example/agent',
      null,
      null,
      'sales',
      'crawler_promote',
      null,
      null,
    ]);
  });

  it('serializes notes JSONB via JSON.stringify, not raw object', async () => {
    await insertTypeReclassification({
      agentUrl: 'https://a',
      newType: 'creative',
      source: 'member_write',
      notes: { decision: 'logged_only_no_promote' },
    });

    const [, params] = mockedQuery.mock.calls[0];
    expect(params[6]).toBe('{"decision":"logged_only_no_promote"}');
  });

  it('preserves explicit null oldType (first-classification case)', async () => {
    await insertTypeReclassification({
      agentUrl: 'https://a',
      oldType: null,
      newType: 'sales',
      source: 'member_write',
    });
    const [, params] = mockedQuery.mock.calls[0];
    expect(params[2]).toBeNull();
  });

  it('swallows DB errors — audit log must never block the caller', async () => {
    mockedQuery.mockRejectedValueOnce(new Error('connection lost'));
    // Must NOT throw — this is observability, not a write barrier.
    await expect(
      insertTypeReclassification({
        agentUrl: 'https://a',
        newType: 'sales',
        source: 'member_write',
      })
    ).resolves.toBeUndefined();
  });

  it('emits audit_log_insert_failed metric with pg error class on DB failure', async () => {
    // Simulate a pg integrity constraint violation (SQLSTATE class 23).
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockedQuery.mockRejectedValueOnce(pgErr);

    await insertTypeReclassification({
      agentUrl: 'https://a',
      newType: 'sales',
      source: 'crawler_promote',
    });

    expect(mockedCaptureEvent).toHaveBeenCalledWith(
      'server-metrics',
      'audit_log_insert_failed',
      { source: 'crawler_promote', error_class: '23' }
    );
  });

  it('falls back to error_class="unknown" when the thrown error has no pg code', async () => {
    mockedQuery.mockRejectedValueOnce(new Error('connection lost'));

    await insertTypeReclassification({
      agentUrl: 'https://a',
      newType: 'sales',
      source: 'member_write',
    });

    expect(mockedCaptureEvent).toHaveBeenCalledWith(
      'server-metrics',
      'audit_log_insert_failed',
      { source: 'member_write', error_class: 'unknown' }
    );
  });

  it('falls back to error_class="unknown" when the pg code is not a well-formed 5-char SQLSTATE', async () => {
    // SQLSTATE is exactly 5 chars by spec — anything else is malformed and
    // labeling it with a truncated prefix would be misleading on a dashboard.
    const malformed = Object.assign(new Error('weird driver'), { code: 'XYZ' });
    mockedQuery.mockRejectedValueOnce(malformed);

    await insertTypeReclassification({
      agentUrl: 'https://a',
      newType: 'sales',
      source: 'backfill_script',
    });

    expect(mockedCaptureEvent).toHaveBeenCalledWith(
      'server-metrics',
      'audit_log_insert_failed',
      { source: 'backfill_script', error_class: 'unknown' }
    );
  });

  it('does not emit the failure metric on a successful insert', async () => {
    await insertTypeReclassification({
      agentUrl: 'https://a',
      newType: 'sales',
      source: 'member_write',
    });

    expect(mockedCaptureEvent).not.toHaveBeenCalled();
  });

  it('accepts each documented source value', async () => {
    for (const source of ['backfill_script', 'crawler_promote', 'member_write'] as const) {
      mockedQuery.mockClear();
      await insertTypeReclassification({
        agentUrl: 'https://a',
        newType: 'sales',
        source,
      });
      expect(mockedQuery.mock.calls[0][1]?.[4]).toBe(source);
    }
  });
});
