import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getPool: vi.fn(),
}));
vi.mock('../../src/addie/services/journey-computation.js', () => ({
  computeJourneyStage: vi.fn(),
}));

import { WorkingGroupDatabase } from '../../src/db/working-group-db.js';

describe('protected AAO site-admin generic database mutation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ slug: 'aao-admin' }], rowCount: 1 });
  });

  it('rejects a generic rename of the protected group before its UPDATE', async () => {
    await expect(new WorkingGroupDatabase().updateWorkingGroup('wg_aao_admin', {
      name: 'Renamed authority group',
      slug: 'renamed-authority-group',
    })).rejects.toThrow('dedicated audited workflow');

    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT slug FROM working_groups WHERE id = $1',
      ['wg_aao_admin'],
    );
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE working_groups'))).toBe(false);
  });

  it('rejects assigning the reserved slug to an ordinary group before lookup or UPDATE', async () => {
    await expect(new WorkingGroupDatabase().updateWorkingGroup('wg_ordinary', {
      slug: 'aao-admin',
    })).rejects.toThrow('reserved');

    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects generic membership and leader mutations by the protected group ID', async () => {
    const db = new WorkingGroupDatabase();

    await expect(db.addMembership({
      working_group_id: 'wg_aao_admin',
      workos_user_id: 'user_target',
    })).rejects.toThrow('dedicated audited workflow');
    await expect(db.setLeaders('wg_aao_admin', ['user_target']))
      .rejects.toThrow('dedicated audited workflow');
    await expect(db.deactivateWorkingGroup('wg_aao_admin'))
      .rejects.toThrow('dedicated audited workflow');

    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('working_group_memberships'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('working_group_leaders'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'inactive'"))).toBe(false);
  });
});
