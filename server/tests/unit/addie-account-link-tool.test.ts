import { beforeEach, describe, expect, it, vi } from 'vitest';

const correlationMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('../../src/db/addie-account-link-correlation-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/addie-account-link-correlation-db.js')>();
  return {
    ...actual,
    createAccountLinkCorrelation: correlationMocks.create,
  };
});

import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';

const slackContext = {
  is_mapped: false,
  is_member: false,
  slack_linked: false,
  slack_user: {
    slack_user_id: 'U123',
    display_name: 'Person',
    email: 'person@example.com',
  },
} as any;

describe('get_account_link origin binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes an opaque correlation created for the current Slack thread', async () => {
    const token = 'a'.repeat(43);
    correlationMocks.create.mockResolvedValueOnce(token);
    const origin = {
      surface: 'slack' as const,
      threadId: 'thread-a',
      initiatingUserId: 'U123',
    };

    const result = await createMemberToolHandlers(slackContext, 'U123', undefined, origin)
      .get('get_account_link')!({});

    expect(correlationMocks.create).toHaveBeenCalledWith(origin);
    expect(result).toContain(`slack_user_id=U123&account_link_correlation=${token}`);
  });

  it('does not persist or expose correlation for a mismatched caller', async () => {
    const result = await createMemberToolHandlers(slackContext, 'U-other', undefined, {
      surface: 'slack',
      threadId: 'thread-a',
      initiatingUserId: 'U123',
    }).get('get_account_link')!({});

    expect(correlationMocks.create).not.toHaveBeenCalled();
    expect(result).toContain("couldn't create a secure account-link URL");
    expect(result).not.toContain('account_link_correlation');
  });

  it('returns a generic retry response when secure origin persistence fails', async () => {
    correlationMocks.create.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await createMemberToolHandlers(slackContext, 'U123', undefined, {
      surface: 'slack',
      threadId: 'thread-a',
      initiatingUserId: 'U123',
    }).get('get_account_link')!({});

    expect(result).toContain("couldn't create a secure account-link URL");
    expect(result).not.toContain('account_link_correlation');
    expect(result).not.toContain('database unavailable');
  });

  it('defines web behavior as ordinary sign-in without an inferred chat destination', async () => {
    const result = await createMemberToolHandlers(null).get('get_account_link')!({});

    expect(result).toContain('https://agenticadvertising.org/auth/login');
    expect(result).not.toContain('account_link_correlation');
    expect(correlationMocks.create).not.toHaveBeenCalled();
  });
});
