import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  context: vi.fn(),
  panel: vi.fn(),
}));

vi.mock('../../src/addie/admin-status-lookup.js', async (original) => ({
  ...await original<typeof import('../../src/addie/admin-status-lookup.js')>(),
  isAuthenticatedUserAAOAdmin: mocks.authorize,
}));
vi.mock('../../src/addie/member-context.js', () => ({ getWebMemberContext: mocks.context }));
vi.mock('../../src/addie/home/builders/admin.js', () => ({ buildAdminPanel: mocks.panel }));
vi.mock('../../src/addie/home/builders/alerts.js', () => ({ buildAlerts: async () => [] }));
vi.mock('../../src/addie/home/builders/activity.js', () => ({ buildActivityFeed: async () => [] }));
vi.mock('../../src/addie/home/builders/quick-actions.js', () => ({ buildQuickActions: () => [] }));
vi.mock('../../src/addie/home/builders/stats.js', () => ({ buildStats: () => ({}) }));
vi.mock('../../src/addie/home/builders/suggested-prompts.js', () => ({ pickPrompts: () => ({ prompts: [], ruleIds: [] }) }));

import { getWebHomeContent } from '../../src/addie/home/web-home-service.js';
import { AAOAdminLookupUnavailableError } from '../../src/addie/admin-status-lookup.js';

describe('Addie home administrator authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ is_mapped: true, is_member: false, slack_linked: false });
    mocks.panel.mockResolvedValue({ escalationCount: 3 });
    mocks.authorize.mockImplementation(async (principal) => (principal.authWorkosUserId ?? principal.id) === 'user_admin');
  });

  it.each([
    ['user_admin', 'user_member', true],
    ['user_member', 'user_admin', false],
  ])('uses authenticated %s instead of canonical %s for the admin panel', async (credential, canonical, allowed) => {
    const principal = { id: canonical, authWorkosUserId: credential, email: `${credential}@example.com` };
    const home = await getWebHomeContent(principal, 'org_selected');
    expect(mocks.authorize).toHaveBeenCalledWith(principal);
    expect(mocks.context).toHaveBeenCalledWith(canonical, 'org_selected', principal);
    expect(home.adminPanel !== null).toBe(allowed);
    expect(mocks.panel).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('propagates a retryable outage without constructing an admin panel', async () => {
    mocks.authorize.mockRejectedValue(new AAOAdminLookupUnavailableError());
    await expect(getWebHomeContent({ id: 'user_admin' })).rejects.toMatchObject({
      code: 'admin_authorization_unavailable', statusCode: 503,
    });
    expect(mocks.panel).not.toHaveBeenCalled();
  });
});
