import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getClient: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { saveTeachingCheckpoint } from '../../src/db/certification-db.js';

describe('saveTeachingCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: [{ id: params[0] }],
    }));
  });

  it('uses a caller-stable primary key to make the shared query retry idempotent', async () => {
    const saved = await saveTeachingCheckpoint({
      workos_user_id: 'user-1',
      module_id: 'A1',
      concepts_covered: ['discovery'],
      concepts_remaining: [],
      current_phase: 'teaching',
    });

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('(id, workos_user_id');
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(sql).toContain('RETURNING *');
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.id).toBe(params[0]);
  });
});
