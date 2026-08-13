import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  joinWorkingGroup: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => {
  const requireAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'user_outsider',
      email: 'mary@endorsable.ai',
      firstName: 'Mary',
      lastName: 'Tester',
    } as Express.Request['user'];
    next();
  };
  const passthrough = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  return {
    requireAuth,
    requireGlobalAdmin: [requireAuth, passthrough, passthrough],
    optionalAuth: passthrough,
    createRequireWorkingGroupLeader: () => passthrough,
    createRequireWorkingGroupMember: () => passthrough,
  };
});

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {},
}));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  invalidateWebAdminStatusCache: vi.fn(),
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/addie/index.js', () => ({ invalidateMemberContextCache: vi.fn() }));
vi.mock('../../src/addie/jobs/committee-document-indexer.js', () => ({ reindexDocument: vi.fn() }));
vi.mock('../../src/addie/mcp/docs-indexer.js', () => ({ refreshWorkingGroupDocs: vi.fn() }));
vi.mock('../../src/slack/sync.js', () => ({
  syncWorkingGroupMembersFromSlack: vi.fn(),
  syncAllWorkingGroupMembersFromSlack: vi.fn(),
}));
vi.mock('../../src/notifications/slack.js', () => ({ notifyPublishedPost: vi.fn() }));
vi.mock('../../src/notifications/notification-service.js', () => ({ notifyUser: vi.fn() }));
vi.mock('../../src/slack/client.js', () => ({
  createChannel: vi.fn(),
  setChannelPurpose: vi.fn(),
  sendChannelMessage: vi.fn(),
  inviteToChannel: vi.fn(),
  isSlackConfigured: vi.fn(() => false),
}));
vi.mock('../../src/addie/services/wg-welcome.js', () => ({ sendWgWelcomeMessage: vi.fn() }));
vi.mock('../../src/services/working-group-membership-service.js', () => {
  class WorkingGroupMembershipError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly meta: Record<string, unknown>,
    ) {
      super(message);
    }

    is(code: string): boolean {
      return this.code === code;
    }
  }

  return {
    joinWorkingGroup: mocks.joinWorkingGroup,
    expressCommitteeInterest: vi.fn(),
    withdrawCommitteeInterest: vi.fn(),
    listMyWorkingGroups: vi.fn(),
    listMyCommitteeInterests: vi.fn(),
    MASTERMIND_COUNCIL_MEMBERSHIP_DENIAL: 'Our Mastermind Councils are for paying member tiers only.',
    MASTERMIND_COUNCIL_MEMBERSHIP_URL:
      'https://agenticadvertising.org/membership#:~:text=Membership%20pricing,-Explorer',
    WorkingGroupMembershipError,
  };
});

const { createCommitteeRouters } = await import('../../src/routes/committees.js');
const { WorkingGroupMembershipError } = await import('../../src/services/working-group-membership-service.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/working-groups', createCommitteeRouters().publicApiRouter);
  return app;
}

describe('Mastermind Council join route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.joinWorkingGroup.mockRejectedValue(
      new WorkingGroupMembershipError(
        'council_membership_required',
        'Paid membership required',
        { slug: 'growth-council', groupName: 'Growth Council' },
      ),
    );
  });

  it('returns the complete linked membership CTA contract for an unpaid caller', async () => {
    const response = await request(createApp())
      .post('/api/working-groups/growth-council/join')
      .expect(403);

    expect(response.body).toEqual({
      error: 'Paid membership required',
      message: 'Our Mastermind Councils are for paying member tiers only.',
      cta_url: 'https://agenticadvertising.org/membership#:~:text=Membership%20pricing,-Explorer',
      cta_label: 'Sign up for membership here',
      cta_suffix: 'starting at $50 annually.',
    });
    expect(mocks.joinWorkingGroup).toHaveBeenCalledWith({
      user: {
        id: 'user_outsider',
        email: 'mary@endorsable.ai',
        firstName: 'Mary',
        lastName: 'Tester',
      },
      slug: 'growth-council',
    });
  });
});
