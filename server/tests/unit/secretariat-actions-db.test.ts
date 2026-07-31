import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import * as secretariatDb from '../../src/db/secretariat-actions-db.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'action-1',
    kind: 'file_issue',
    title: 'Test action',
    rationale: 'Because reasons',
    payload: { title: 'x', body: 'y' },
    status: 'proposed',
    origin: 'test',
    dedupe_key: null,
    edited: false,
    result: null,
    error: null,
    decided_by: null,
    decided_at: null,
    executed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function qResult(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as any;
}

describe('secretariat-actions-db', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('propose', () => {
    it('inserts and returns the new row when there is no dedupe conflict', async () => {
      const inserted = row({ dedupe_key: 'k1' });
      mockedQuery.mockResolvedValueOnce(qResult([inserted]));

      const result = await secretariatDb.propose({
        kind: 'file_issue',
        title: 'Test action',
        rationale: 'Because reasons',
        payload: { title: 'x', body: 'y' },
        origin: 'test',
        dedupe_key: 'k1',
      });

      expect(result).toEqual(inserted);
      expect(mockedQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO secretariat_actions/);
      expect(sql).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
      expect(params).toEqual(['file_issue', 'Test action', 'Because reasons', JSON.stringify({ title: 'x', body: 'y' }), 'test', 'k1']);
    });

    it('returns the existing row on dedupe_key conflict instead of inserting a duplicate', async () => {
      const existing = row({ dedupe_key: 'k1', id: 'existing-1' });
      mockedQuery
        .mockResolvedValueOnce(qResult([])) // INSERT ... ON CONFLICT DO NOTHING -> no row
        .mockResolvedValueOnce(qResult([existing])); // SELECT existing

      const result = await secretariatDb.propose({
        kind: 'file_issue',
        title: 'Test action',
        rationale: 'Because reasons',
        payload: {},
        origin: 'test',
        dedupe_key: 'k1',
      });

      expect(result).toEqual(existing);
      expect(mockedQuery).toHaveBeenCalledTimes(2);
      const [selectSql, selectParams] = mockedQuery.mock.calls[1];
      expect(selectSql).toMatch(/SELECT .* FROM secretariat_actions WHERE dedupe_key = \$1/s);
      expect(selectParams).toEqual(['k1']);
    });

    it('null-pads dedupe_key when omitted', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([row()]));
      await secretariatDb.propose({
        kind: 'file_issue',
        title: 't',
        rationale: 'r',
        payload: {},
        origin: 'test',
      });
      const [, params] = mockedQuery.mock.calls[0];
      expect(params?.[5]).toBeNull();
    });
  });

  describe('approve', () => {
    it('transitions proposed -> approved and records the decider', async () => {
      const approved = row({ status: 'approved', decided_by: 'admin@example.com' });
      mockedQuery.mockResolvedValueOnce(qResult([approved]));

      const result = await secretariatDb.approve('action-1', 'admin@example.com');

      expect(result).toEqual(approved);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE secretariat_actions/);
      expect(sql).toMatch(/SET status = 'approved'/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'proposed'/);
      expect(params).toEqual(['action-1', 'admin@example.com']);
    });

    it('returns null when the action is not in proposed (already decided)', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([]));
      const result = await secretariatDb.approve('action-1', 'admin@example.com');
      expect(result).toBeNull();
    });
  });

  describe('reject', () => {
    it('transitions proposed -> rejected and stores the reason', async () => {
      const rejected = row({ status: 'rejected', decided_by: 'admin@example.com', error: 'not needed' });
      mockedQuery.mockResolvedValueOnce(qResult([rejected]));

      const result = await secretariatDb.reject('action-1', 'admin@example.com', 'not needed');

      expect(result).toEqual(rejected);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/SET status = 'rejected'/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'proposed'/);
      expect(params).toEqual(['action-1', 'admin@example.com', 'not needed']);
    });

    it('returns null when the action is not in proposed', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([]));
      const result = await secretariatDb.reject('action-1', 'admin@example.com', 'reason');
      expect(result).toBeNull();
    });
  });

  describe('editPayload', () => {
    it('updates payload, optionally title, and sets edited = true, only while proposed', async () => {
      const edited = row({ payload: { a: 1 }, title: 'New title', edited: true });
      mockedQuery.mockResolvedValueOnce(qResult([edited]));

      const result = await secretariatDb.editPayload('action-1', { a: 1 }, 'New title');

      expect(result).toEqual(edited);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/SET payload = \$2::jsonb, title = COALESCE\(\$3, title\), edited = true/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'proposed'/);
      expect(params).toEqual(['action-1', JSON.stringify({ a: 1 }), 'New title']);
    });

    it('returns null when the action is not in proposed', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([]));
      const result = await secretariatDb.editPayload('action-1', { a: 1 });
      expect(result).toBeNull();
    });
  });

  describe('claimForExecution', () => {
    it('atomically transitions approved -> executing', async () => {
      const executing = row({ status: 'executing' });
      mockedQuery.mockResolvedValueOnce(qResult([executing]));

      const result = await secretariatDb.claimForExecution('action-1');

      expect(result).toEqual(executing);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/SET status = 'executing'/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'approved'/);
      expect(params).toEqual(['action-1']);
    });

    it('returns null when the action is not (or no longer) approved — the double-execution guard', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([]));
      const result = await secretariatDb.claimForExecution('action-1');
      expect(result).toBeNull();
    });
  });

  describe('markDone / markFailed', () => {
    it('markDone transitions executing -> done and stores the result', async () => {
      const done = row({ status: 'done', result: { prUrl: 'https://x/pr/1' } });
      mockedQuery.mockResolvedValueOnce(qResult([done]));

      const result = await secretariatDb.markDone('action-1', { prUrl: 'https://x/pr/1' });

      expect(result).toEqual(done);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/SET status = 'done'/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'executing'/);
      expect(params).toEqual(['action-1', JSON.stringify({ prUrl: 'https://x/pr/1' })]);
    });

    it('markFailed transitions executing -> failed and stores the error', async () => {
      const failed = row({ status: 'failed', error: 'boom' });
      mockedQuery.mockResolvedValueOnce(qResult([failed]));

      const result = await secretariatDb.markFailed('action-1', 'boom');

      expect(result).toEqual(failed);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/SET status = 'failed'/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'executing'/);
      expect(params).toEqual(['action-1', 'boom']);
    });
  });

  describe('retry', () => {
    it('transitions failed -> proposed and clears the prior decision', async () => {
      const retried = row({ status: 'proposed', error: null, decided_by: null, decided_at: null });
      mockedQuery.mockResolvedValueOnce(qResult([retried]));

      const result = await secretariatDb.retry('action-1');

      expect(result).toEqual(retried);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/SET status = 'proposed', error = NULL, decided_by = NULL, decided_at = NULL/);
      expect(sql).toMatch(/WHERE id = \$1 AND status = 'failed'/);
      expect(params).toEqual(['action-1']);
    });

    it('returns null when the action is not in failed', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([]));
      const result = await secretariatDb.retry('action-1');
      expect(result).toBeNull();
    });
  });

  describe('listByStatus', () => {
    it('filters by status when provided', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([row()]));
      await secretariatDb.listByStatus({ status: 'proposed', limit: 50 });
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE status = \$1/);
      expect(params).toEqual(['proposed', 50]);
    });

    it('clamps limit to 200 max', async () => {
      mockedQuery.mockResolvedValueOnce(qResult([]));
      await secretariatDb.listByStatus({ limit: 5000 });
      const [, params] = mockedQuery.mock.calls[0];
      expect(params).toEqual([200]);
    });
  });

  describe('getStats', () => {
    it('returns by_kind_status counts and per-kind approval rate', async () => {
      mockedQuery
        .mockResolvedValueOnce(qResult([
          { kind: 'file_issue', status: 'done', count: '3' },
          { kind: 'file_issue', status: 'failed', count: '1' },
        ]))
        .mockResolvedValueOnce(qResult([
          { kind: 'file_issue', decided: '4', approved_without_edit: '2' },
        ]));

      const stats = await secretariatDb.getStats();

      expect(stats.by_kind_status).toEqual([
        { kind: 'file_issue', status: 'done', count: 3 },
        { kind: 'file_issue', status: 'failed', count: 1 },
      ]);
      expect(stats.approval_rate_by_kind).toEqual([
        { kind: 'file_issue', decided: 4, approved_without_edit: 2, rate: 0.5 },
      ]);
    });

    it('reports rate: null when a kind has never been decided', async () => {
      mockedQuery
        .mockResolvedValueOnce(qResult([]))
        .mockResolvedValueOnce(qResult([{ kind: 'open_pr', decided: '0', approved_without_edit: '0' }]));

      const stats = await secretariatDb.getStats();
      expect(stats.approval_rate_by_kind).toEqual([
        { kind: 'open_pr', decided: 0, approved_without_edit: 0, rate: null },
      ]);
    });
  });
});
