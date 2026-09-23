import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getPool: () => ({ query: mocks.query }),
}));

import { WorkingGroupDatabase } from '../../src/db/working-group-db.js';

describe('reserved administrator group descendant visibility', () => {
  const parent = { id: 'parent', slug: 'ordinary-parent', parent_id: null, is_private: false };
  const reserved = { id: 'reserved', slug: 'aao-admin', parent_id: parent.id, is_private: true };
  const publicChild = { id: 'public-child', slug: 'public-child', parent_id: parent.id, is_private: false };
  const privateChild = { id: 'private-child', slug: 'private-child', parent_id: parent.id, is_private: true };
  let db: WorkingGroupDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new WorkingGroupDatabase();
    mocks.query.mockResolvedValue({ rows: [parent, reserved, publicChild, privateChild] });
  });

  it.each([true, false])('requires explicit reserved authority even when canonical membership exists and is_private=%s', async (isPrivate) => {
    mocks.query.mockResolvedValue({ rows: [parent, { ...reserved, is_private: isPrivate }, publicChild, privateChild] });
    const member = vi.spyOn(db, 'isMember').mockResolvedValue(true);

    const visible = await db.getVisibleDescendantIds(parent.id, 'canonical-admin', {
      canViewReservedAdminGroup: false,
    });

    expect(visible).toEqual([parent.id, publicChild.id, privateChild.id]);
    expect(member).not.toHaveBeenCalledWith(reserved.id, expect.anything());
    expect(member).toHaveBeenCalledWith(privateChild.id, 'canonical-admin');
  });

  it('does not infer reserved authority from an ordinary admin-view flag', async () => {
    const member = vi.spyOn(db, 'isMember').mockResolvedValue(true);
    expect(await db.getVisibleDescendantIds(parent.id, 'canonical-admin', { isAdmin: true }))
      .toEqual([parent.id, publicChild.id, privateChild.id]);
    expect(member).not.toHaveBeenCalled();
  });

  it('keeps anonymous parent feeds public without exposing the reserved child', async () => {
    const member = vi.spyOn(db, 'isMember');
    expect(await db.getVisibleDescendantIds(parent.id, null)).toEqual([parent.id, publicChild.id]);
    expect(member).not.toHaveBeenCalled();
  });

  it('permits the reserved child without widening ordinary private event visibility', async () => {
    const member = vi.spyOn(db, 'isMember').mockResolvedValue(false);
    expect(await db.getVisibleDescendantIds(parent.id, 'canonical-nonadmin', {
      canViewReservedAdminGroup: true,
    })).toEqual([parent.id, reserved.id, publicChild.id]);
    expect(member).not.toHaveBeenCalledWith(reserved.id, expect.anything());
    expect(member).toHaveBeenCalledWith(privateChild.id, 'canonical-nonadmin');
  });

  it('preserves the explicit ordinary private-group bypass used by admin post views', async () => {
    const member = vi.spyOn(db, 'isMember');
    expect(await db.getVisibleDescendantIds(parent.id, 'canonical-nonadmin', {
      isAdmin: true, canViewReservedAdminGroup: true,
    })).toEqual([parent.id, reserved.id, publicChild.id, privateChild.id]);
    expect(member).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires reserved authority even when the requested target is the reserved group: %s', async (allowed) => {
    mocks.query.mockResolvedValue({ rows: [reserved] });
    const member = vi.spyOn(db, 'isMember').mockResolvedValue(true);
    expect(await db.getVisibleDescendantIds(reserved.id, 'canonical-admin', {
      canViewReservedAdminGroup: allowed,
    })).toEqual(allowed ? [reserved.id] : []);
    expect(member).not.toHaveBeenCalled();
  });
});
