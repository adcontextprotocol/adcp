import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { insertTypeReclassification } from '../../src/db/type-reclassification-log-db.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

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
