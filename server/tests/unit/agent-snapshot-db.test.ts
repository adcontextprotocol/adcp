import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { AgentSnapshotDatabase } from '../../src/db/agent-snapshot-db.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

function mockResult<T>(rows: T[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

describe('AgentSnapshotDatabase.filterMeasurementAgents', () => {
  let db: AgentSnapshotDatabase;

  beforeEach(() => {
    db = new AgentSnapshotDatabase();
    vi.clearAllMocks();
  });

  it('returns all measurement agents when no filters provided', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([{ agent_url: 'https://a.example.com' }]));
    const result = await db.filterMeasurementAgents({});
    expect(result).toEqual(new Set(['https://a.example.com']));
    const sql: string = mockedQuery.mock.calls[0][0] as string;
    expect(sql).toContain('measurement_capabilities_json IS NOT NULL');
    expect(sql).not.toContain('@>');
  });

  it('solo metric_id uses independent @> containment on metric_id only', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([]));
    await db.filterMeasurementAgents({ metric_ids: ['attention_units'] });
    const sql: string = mockedQuery.mock.calls[0][0] as string;
    const params = mockedQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain('@>');
    expect(JSON.parse(params[0] as string)).toEqual({ metrics: [{ metric_id: 'attention_units' }] });
    expect(JSON.parse(params[0] as string)).not.toHaveProperty('metrics.0.accreditations');
  });

  it('solo accreditation uses independent @> containment on accreditation only', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([]));
    await db.filterMeasurementAgents({ accreditations: ['MRC'] });
    const sql: string = mockedQuery.mock.calls[0][0] as string;
    const params = mockedQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain('@>');
    expect(JSON.parse(params[0] as string)).toEqual({
      metrics: [{ accreditations: [{ accrediting_body: 'MRC' }] }],
    });
  });

  it('combined metric_id + accreditation uses per-metric nested containment (regression: must not use independent predicates)', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([]));
    await db.filterMeasurementAgents({ metric_ids: ['attention_units'], accreditations: ['MRC'] });
    const params = mockedQuery.mock.calls[0][1] as unknown[];
    // Must have exactly ONE extra param combining both constraints
    expect(params).toHaveLength(1);
    expect(JSON.parse(params[0] as string)).toEqual({
      metrics: [{ metric_id: 'attention_units', accreditations: [{ accrediting_body: 'MRC' }] }],
    });
  });

  it('cross-product: two metric_ids × one accreditation emits two per-pair probes (both ANDed)', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([]));
    await db.filterMeasurementAgents({
      metric_ids: ['attention_units', 'emissions'],
      accreditations: ['MRC'],
    });
    const params = mockedQuery.mock.calls[0][1] as unknown[];
    expect(params).toHaveLength(2);
    expect(JSON.parse(params[0] as string)).toEqual({
      metrics: [{ metric_id: 'attention_units', accreditations: [{ accrediting_body: 'MRC' }] }],
    });
    expect(JSON.parse(params[1] as string)).toEqual({
      metrics: [{ metric_id: 'emissions', accreditations: [{ accrediting_body: 'MRC' }] }],
    });
    const sql: string = mockedQuery.mock.calls[0][0] as string;
    // Both probes must appear as AND conditions, not OR
    const andCount = (sql.match(/ AND /g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(2);
  });

  it('cross-product: one metric_id × two accreditations emits two per-pair probes', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([]));
    await db.filterMeasurementAgents({
      metric_ids: ['attention_units'],
      accreditations: ['MRC', 'ABC'],
    });
    const params = mockedQuery.mock.calls[0][1] as unknown[];
    expect(params).toHaveLength(2);
    expect(JSON.parse(params[0] as string)).toEqual({
      metrics: [{ metric_id: 'attention_units', accreditations: [{ accrediting_body: 'MRC' }] }],
    });
    expect(JSON.parse(params[1] as string)).toEqual({
      metrics: [{ metric_id: 'attention_units', accreditations: [{ accrediting_body: 'ABC' }] }],
    });
  });

  it('q filter uses jsonb_array_elements EXISTS regardless of other filters', async () => {
    mockedQuery.mockResolvedValueOnce(mockResult([]));
    await db.filterMeasurementAgents({ q: 'attention' });
    const sql: string = mockedQuery.mock.calls[0][0] as string;
    expect(sql).toContain('jsonb_array_elements');
    expect(sql).toContain('ILIKE');
  });
});
