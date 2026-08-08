import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getClient: vi.fn(),
  query: mocks.query,
}));

vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));

import { checkAndAwardCredentials } from '../../src/db/certification-db.js';

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
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: false });
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM organization_memberships')) {
        return { rows: [{ workos_organization_id: 'org_free' }] };
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
});
