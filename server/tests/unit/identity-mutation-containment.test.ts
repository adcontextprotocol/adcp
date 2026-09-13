import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ getPool }));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));

import { mergeUsers, previewUserMerge } from '../../src/db/user-merge-db.js';
import { promoteSecondaryIfPrimaryDeleted } from '../../src/db/identity-db.js';
import { IdentityMutationDisabledError } from '../../src/db/identity-mutation-policy.js';

const refusal = {
  code: 'identity_mutation_disabled',
  message: 'Identity consolidation is disabled until authority and provenance can be preserved.',
};

describe('identity mutation containment at the database seam', () => {
  beforeEach(() => {
    getPool.mockReset();
    getPool.mockImplementation(() => {
      throw new Error('The containment guard must refuse before accessing the database');
    });
  });

  afterEach(() => {
    expect(getPool).not.toHaveBeenCalled();
  });

  it.each([
    ['automatic', 'user_sam', 'user_jordan', 'auto'],
    ['member', 'user_sam', 'user_jordan', 'user_sam'],
    ['admin', 'user_jordan', 'user_sam', 'user_admin'],
    ['same credential', 'user_sam', 'user_sam', 'user_sam'],
    ['missing credential', '', 'user_jordan', 'user_admin'],
  ])('refuses %s merges before opening a connection', async (_caller, primary, secondary, actor) => {
    await expect(mergeUsers(primary, secondary, actor)).rejects.toMatchObject(refusal);
  });

  it('rejects promotion and operator confirmation options without a bypass', async () => {
    await expect(mergeUsers('user_sam', 'user_jordan', 'user_admin', {
      ensurePrimaryFlag: true,
      auditContext: { consolidation_confirmed: true, consolidate: true },
    })).rejects.toBeInstanceOf(IdentityMutationDisabledError);
  });

  it.each(['user_sam', 'user_jordan', ''])('refuses automatic primary promotion for %j', async (userId) => {
    await expect(promoteSecondaryIfPrimaryDeleted(userId)).rejects.toMatchObject(refusal);
  });

  it('keeps simultaneous, reversed, and replayed operations harmless', async () => {
    const attempts = Array.from({ length: 12 }, (_, index) => index % 3 === 0
      ? promoteSecondaryIfPrimaryDeleted('user_jordan')
      : mergeUsers(
        index % 2 ? 'user_sam' : 'user_jordan',
        index % 2 ? 'user_jordan' : 'user_sam',
        'user_admin',
        { ensurePrimaryFlag: true, auditContext: { consolidation_confirmed: true } },
      ));
    for (const result of await Promise.allSettled(attempts)) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject(refusal);
    }
    await expect(mergeUsers('user_sam', 'user_jordan', 'user_admin')).rejects.toMatchObject(refusal);
  });
});

describe('read-only merge detection', () => {
  it('keeps preview available and issues only reads', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: '1' }] });
    const release = vi.fn();
    getPool.mockReset();
    getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue({ query, release }) });

    const preview = await previewUserMerge('user_sam', 'user_jordan');

    expect(preview.tables).toContainEqual({ table_name: 'organization_memberships', row_count: 1 });
    expect(query).toHaveBeenCalled();
    for (const [sql, parameters] of query.mock.calls) {
      expect(sql).toMatch(/^SELECT COUNT\(\*\)/);
      expect(parameters).toEqual(['user_jordan']);
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
