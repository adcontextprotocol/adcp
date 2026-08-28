import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { resolvePolicy } from '../../src/db/policies-db.js';

const queryMock = vi.mocked(query);

const canonicalContent = {
  policy_id: 'example_policy',
  source: 'registry',
  version: '1.0.0',
  name: 'Example policy',
  category: 'standard',
  enforcement: 'must',
  jurisdictions: [],
  region_aliases: {},
  policy_categories: [],
  governance_domains: ['campaign'],
  effective_date: '2026-01-01',
  source_url: 'https://example.com/policy',
  source_name: 'Example issuer',
  policy: 'Example policy text.',
};

const validAcceptanceProfile = {
  profile_id: 'example_profile',
  version: '1.0.0',
  content_digest: `sha256:${'c'.repeat(64)}`,
  policy_refs: [{
    policy_id: 'example_policy',
    version: '1.0.0',
    content_digest: `sha256:${'a'.repeat(64)}`,
  }],
  coverage: 'partial',
  rules: [{
    rule_id: 'example_rule',
    subject_category: 'regulated_goods',
    applies_to: ['media_buy'],
    disposition: 'allowed',
  }],
};

describe('immutable policy publication resolution', () => {
  beforeEach(() => queryMock.mockReset());

  it('resolves an exact retired version from its canonical publication snapshot', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        policy_id: 'example_policy',
        version: '1.0.0',
        content_digest: `sha256:${'a'.repeat(64)}`,
        canonical_content: canonicalContent,
        acceptance_profile: validAcceptanceProfile,
        published_at: '2026-01-02T00:00:00.000Z',
      }],
    } as never);

    const resolved = await resolvePolicy('example_policy', '1.0.0');

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('FROM policy_publications');
    expect(resolved).toMatchObject({
      policy_id: 'example_policy',
      version: '1.0.0',
      source_type: 'registry',
      content_digest: `sha256:${'a'.repeat(64)}`,
      canonical_content: canonicalContent,
      acceptance_profile: validAcceptanceProfile,
    });
  });

  it('does not fall back to the mutable policy row when an exact publication is absent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] } as never);

    const resolved = await resolvePolicy('example_policy', '1.0.0');

    expect(resolved).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('FROM policy_publications');
    expect(queryMock.mock.calls[0][0]).not.toContain('FROM policies policy');
  });

  it.each([
    ['empty policy references', { ...validAcceptanceProfile, policy_refs: [] }],
    ['a malformed profile digest', { ...validAcceptanceProfile, content_digest: 'sha256:not-a-digest' }],
    ['complete coverage without an explicit scope', { ...validAcceptanceProfile, coverage: 'complete' }],
    ['a conditional rule without requirements', {
      ...validAcceptanceProfile,
      rules: [{ ...validAcceptanceProfile.rules[0], disposition: 'conditional' }],
    }],
  ])('rejects an acceptance profile with %s', async (_label, acceptanceProfile) => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        policy_id: 'example_policy',
        version: '1.0.0',
        content_digest: `sha256:${'a'.repeat(64)}`,
        canonical_content: canonicalContent,
        acceptance_profile: acceptanceProfile,
        published_at: '2026-01-02T00:00:00.000Z',
      }],
    } as never);

    await expect(resolvePolicy('example_policy', '1.0.0')).rejects.toThrow('Invalid policy acceptance_profile');
  });

  it('joins the canonical snapshot when resolving the current version', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        ...canonicalContent,
        source_type: 'registry',
        review_status: 'approved',
        description: null,
        channels: null,
        sunset_date: null,
        issuer: null,
        acceptance_profile: null,
        guidance: null,
        exemplars: null,
        ext: null,
        content_digest: `sha256:${'b'.repeat(64)}`,
        canonical_content: canonicalContent,
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      }],
    } as never);

    const resolved = await resolvePolicy('example_policy');

    expect(queryMock.mock.calls[0][0]).toContain('LEFT JOIN policy_publications');
    expect(resolved?.canonical_content).toEqual(canonicalContent);
    expect(resolved?.content_digest).toBe(`sha256:${'b'.repeat(64)}`);
  });
});
