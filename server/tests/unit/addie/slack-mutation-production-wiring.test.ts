import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookupMapping: vi.fn(),
  epoch: vi.fn(),
}));

vi.mock('../../../src/db/slack-db.js', () => ({
  SlackDatabase: class {
    getBySlackUserId = mocks.lookupMapping;
  },
}));

vi.mock('../../../src/db/authorization-epoch-db.js', () => ({
  getExactCredentialAuthorizationEpoch: mocks.epoch,
}));

import { slackMutationAuthorityOptions } from '../../../src/addie/bolt-app.js';

describe('production Slack mutation authority wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch.mockResolvedValue('9');
  });

  it('ignores stale MemberContext and binds capture plus dispatch to the live mapping', async () => {
    mocks.lookupMapping.mockResolvedValue({
      slack_user_id: 'U_ACTOR',
      workos_user_id: 'credential_fresh',
    });
    const staleMemberContext = {
      workos_user: {
        workos_user_id: 'credential_stale',
        email: 'stale@example.test',
      },
    };
    const options = slackMutationAuthorityOptions('U_ACTOR', staleMemberContext as never);
    const revalidate = await options.captureSideEffectAuthority!({
      mutationToolNames: ['create_payment_link'],
    });

    expect(mocks.epoch).toHaveBeenCalledWith('credential_fresh');
    expect(mocks.epoch).not.toHaveBeenCalledWith('credential_stale');
    await expect(revalidate!({ toolName: 'create_payment_link', parameters: {} }))
      .resolves.toEqual({ allowed: true });
    expect(mocks.lookupMapping).toHaveBeenCalledTimes(2);
    expect(mocks.epoch).toHaveBeenCalledTimes(2);
  });
});
