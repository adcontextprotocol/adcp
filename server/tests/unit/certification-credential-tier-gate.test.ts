import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  invalidateMembershipCache: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getClient: vi.fn(),
  query: mocks.query,
}));

vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
  invalidateMembershipCache: mocks.invalidateMembershipCache,
}));

import { checkAndAwardCredentials } from '../../src/db/certification-db.js';

let orgRows: Array<{ workos_organization_id: string }>;

const basics = {
  id: 'basics',
  tier: 1,
  name: 'AdCP Basics',
  required_modules: [],
  requires_credential: null,
  requires_any_track_complete: false,
  sort_order: 1,
};
const practitioner = {
  ...basics,
  id: 'practitioner',
  tier: 2,
  name: 'AdCP Practitioner',
  sort_order: 2,
};

describe('credential tier award gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgRows = [{ workos_organization_id: 'org_free' }];
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: false });
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM organization_memberships')) {
        return { rows: orgRows };
      }
      if (sql.includes('FROM certification_credentials ORDER BY')) {
        return { rows: [basics, practitioner] };
      }
      if (sql.includes('FROM user_credentials WHERE workos_user_id') && sql.includes('ORDER BY awarded_at')) {
        return { rows: [] };
      }
      if (sql.includes('FROM certification_credentials WHERE id')) {
        return { rows: [params?.[0] === 'basics' ? basics : practitioner] };
      }
      if (sql.includes('INSERT INTO user_credentials')) {
        return { rows: [{ workos_user_id: 'user_free', credential_id: params?.[1] }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it('awards the free credential without evaluating or issuing paid tiers', async () => {
    const awarded = await checkAndAwardCredentials('user_free', { maxTier: 1 });

    expect(awarded).toEqual(['basics']);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM certification_credentials WHERE id'),
      ['practitioner'],
    );
  });

  it('defaults background award calls to the free tier for inactive learners', async () => {
    const awarded = await checkAndAwardCredentials('user_free');

    expect(mocks.resolveEffectiveMembership).toHaveBeenCalledWith('org_free');
    expect(awarded).toEqual(['basics']);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM certification_credentials WHERE id'),
      ['practitioner'],
    );
  });

  it('allows the default background path to award paid tiers for an active member', async () => {
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });

    const awarded = await checkAndAwardCredentials('user_member');

    expect(mocks.invalidateMembershipCache).toHaveBeenCalledWith('org_free');
    expect(awarded).toEqual(['basics', 'practitioner']);
  });

  it('does not let an explicit unlimited caller cap bypass inactive membership', async () => {
    const awarded = await checkAndAwardCredentials('user_free', {
      maxTier: Number.POSITIVE_INFINITY,
    });

    expect(awarded).toEqual(['basics']);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM certification_credentials WHERE id'),
      ['practitioner'],
    );
  });

  it('recognizes membership through any of a learner\'s organizations', async () => {
    orgRows = [
      { workos_organization_id: 'org_inactive' },
      { workos_organization_id: 'org_active' },
    ];
    mocks.resolveEffectiveMembership.mockImplementation(async (orgId: string) => ({
      is_member: orgId === 'org_active',
    }));

    const awarded = await checkAndAwardCredentials('user_multi_org');

    expect(awarded).toEqual(['basics', 'practitioner']);
    expect(mocks.invalidateMembershipCache).toHaveBeenCalledWith('org_inactive');
    expect(mocks.invalidateMembershipCache).toHaveBeenCalledWith('org_active');
  });

  it('limits a learner with no organization to the free tier', async () => {
    orgRows = [];

    const awarded = await checkAndAwardCredentials('user_no_org');

    expect(awarded).toEqual(['basics']);
    expect(mocks.resolveEffectiveMembership).not.toHaveBeenCalled();
  });

  it('treats a NaN caller cap as free-only', async () => {
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });

    const awarded = await checkAndAwardCredentials('user_member', { maxTier: Number.NaN });

    expect(awarded).toEqual(['basics']);
  });
});
