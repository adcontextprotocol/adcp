import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
  query: dbMocks.query,
}));

import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';

const memberContext = {
  workos_user: {
    workos_user_id: 'user-profile-url-test',
  },
} as any;

describe('Addie update_my_profile URL validation', () => {
  beforeEach(() => {
    dbMocks.query.mockReset();
  });

  it.each([
    ['linkedin_url', 'javascript:alert(1)'],
    ['linkedin_url', 'https://user:secret@linkedin.example/in/acme'],
    ['twitter_url', 'http://social.example/acme'],
    ['twitter_url', 'https://user:secret@social.example/acme'],
  ])('rejects unsafe %s before persistence', async (field, value) => {
    const handler = createMemberToolHandlers(memberContext).get('update_my_profile')!;

    const result = await handler({ [field]: value });

    expect(result).toBe(`${field} must be an HTTPS URL without credentials.`);
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it('preserves valid HTTPS profile URLs', async () => {
    dbMocks.query.mockResolvedValue({ rowCount: 1, rows: [{ workos_user_id: 'user-profile-url-test' }] });
    const handler = createMemberToolHandlers(memberContext).get('update_my_profile')!;

    const result = await handler({
      linkedin_url: 'https://www.linkedin.com/in/acme?ref=addie',
      twitter_url: 'https://social.example/acme#profile',
    });

    expect(result).toContain('Profile updated!');
    expect(dbMocks.query).toHaveBeenCalledOnce();
    expect(dbMocks.query.mock.calls[0]?.[1]).toEqual([
      'https://www.linkedin.com/in/acme?ref=addie',
      'https://social.example/acme#profile',
      'user-profile-url-test',
    ]);
  });

  it('uses the same Twitter/X policy for company listing updates', async () => {
    const handler = createMemberToolHandlers(memberContext).get('update_company_listing')!;

    const result = await handler({ twitter_url: 'http://social.example/acme' });

    expect(result).toBe('twitter_url must be an HTTPS URL without credentials.');
    expect(dbMocks.query).not.toHaveBeenCalled();
  });
});
