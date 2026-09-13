import { afterEach, describe, expect, it, vi } from 'vitest';
import * as escalationDb from '../../../src/db/escalation-db.js';
import { createAdminToolHandlers } from '../../../src/addie/mcp/admin-tools.js';
import { normalizeToolResult, renderToolResultForModel } from '../../../src/addie/tool-result-contract.js';

afterEach(() => vi.restoreAllMocks());

const record = (id: number, overrides: Partial<escalationDb.Escalation> = {}): escalationDb.Escalation => ({
  id,
  summary: 'Sam needs help with campaign setup.',
  priority: 'normal',
  category: 'needs_human_action',
  status: 'open',
  user_display_name: 'Sam Adeyemi',
  created_at: new Date('2026-09-13T12:00:00Z'),
  ...overrides,
} as escalationDb.Escalation);

const handler = (input: Record<string, unknown> = {}) =>
  createAdminToolHandlers().get('list_escalations')!(input);

describe('admin escalation list completeness', () => {
  it('returns every ticket on a page, an independent total, and the next offset', async () => {
    const records = Array.from({ length: 10 }, (_, index) => record(700 + index));
    const list = vi.spyOn(escalationDb, 'listEscalations').mockResolvedValue(records);
    const count = vi.spyOn(escalationDb, 'countEscalations').mockResolvedValue(12);

    const page = JSON.parse(await handler());

    expect(page).toMatchObject({ total_count: 12, returned_count: 10, offset: 0, next_offset: 10 });
    expect(page.escalations.map((entry: { id: number }) => entry.id)).toEqual(records.map(entry => entry.id));
    expect(list).toHaveBeenCalledWith({ status: 'open', category: undefined, limit: 10, offset: 0 });
    expect(count).toHaveBeenCalledWith({ status: 'open', category: undefined });
  });

  it('continues the same filtered list and identifies the final page', async () => {
    const list = vi.spyOn(escalationDb, 'listEscalations').mockResolvedValue([record(710), record(711)]);
    const count = vi.spyOn(escalationDb, 'countEscalations').mockResolvedValue(12);

    const page = JSON.parse(await handler({ status: 'in_progress', category: 'capability_gap', offset: 10 }));

    expect(page).toMatchObject({
      status_filter: 'in_progress', category_filter: 'capability_gap',
      total_count: 12, returned_count: 2, offset: 10, next_offset: null,
    });
    expect(list).toHaveBeenCalledWith({ status: 'in_progress', category: 'capability_gap', limit: 10, offset: 10 });
    expect(count).toHaveBeenCalledWith({ status: 'in_progress', category: 'capability_gap' });
  });

  it.each([0, 12])('distinguishes an empty page from an empty queue (total=%s)', async (total) => {
    vi.spyOn(escalationDb, 'listEscalations').mockResolvedValue([]);
    vi.spyOn(escalationDb, 'countEscalations').mockResolvedValue(total);

    expect(JSON.parse(await handler({ offset: 20 }))).toMatchObject({
      total_count: total, returned_count: 0, next_offset: null, escalations: [],
    });
  });

  it.each([{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { limit: '10' }, { offset: -1 }, { offset: 0.5 }, { offset: Infinity }])(
    'rejects invalid pagination before reading records: %j', async (input) => {
      const list = vi.spyOn(escalationDb, 'listEscalations');
      const count = vi.spyOn(escalationDb, 'countEscalations');

      expect(await handler(input)).toContain('must be');
      expect(list).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    },
  );

  it('keeps the maximum page intact through model-context normalization', async () => {
    const records = Array.from({ length: 25 }, (_, index) => record(700 + index, {
      summary: '\u0001"\\'.repeat(400),
      user_display_name: '\u0001"\\'.repeat(200),
      original_request: 'Full request is available through an ID lookup. '.repeat(200),
    }));
    vi.spyOn(escalationDb, 'listEscalations').mockResolvedValue(records);
    vi.spyOn(escalationDb, 'countEscalations').mockResolvedValue(25);

    const raw = await handler({ limit: 25 });
    const normalized = normalizeToolResult('list_escalations', raw);
    const model = renderToolResultForModel('list_escalations', normalized);

    expect(normalized.model_context_truncated).toBe(false);
    expect(model.framing_truncated).toBe(false);
    const page = JSON.parse(model.content);
    expect(page.escalations.map((entry: { id: number }) => entry.id)).toEqual(records.map(entry => entry.id));
    expect(page.escalations[0].summary).toHaveLength(160);
    expect(page.escalations[0].requester).toHaveLength(80);
    expect(raw).not.toContain('\\u0001');
    expect(raw).not.toContain('Full request');
  });

  it('retains full details for a specific ticket without applying list filters', async () => {
    const originalRequest = 'Check the complete campaign configuration. '.repeat(20);
    vi.spyOn(escalationDb, 'getEscalation').mockResolvedValue(record(700, { original_request: originalRequest }));
    const list = vi.spyOn(escalationDb, 'listEscalations');
    const count = vi.spyOn(escalationDb, 'countEscalations');

    expect(await handler({ escalation_id: 700, status: 'resolved' })).toContain(originalRequest);
    expect(list).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('reports a query failure without presenting a partial page as complete', async () => {
    vi.spyOn(escalationDb, 'listEscalations').mockResolvedValue([record(700)]);
    vi.spyOn(escalationDb, 'countEscalations').mockRejectedValue(new Error('unavailable'));

    expect(await handler()).toContain('Failed to list escalations');
  });
});
