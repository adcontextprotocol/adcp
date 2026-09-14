import express from 'express';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), lifecycle: vi.fn(), getSlackUsers: vi.fn(), getUserChannels: vi.fn(),
  chapterWrite: vi.fn(), preferenceWrite: vi.fn(), unifiedCache: vi.fn(), memberCache: vi.fn(),
  adminCache: vi.fn(), webAdminCache: vi.fn(), workos: vi.fn(), welcome: vi.fn(),
  marketing: vi.fn(), prospect: vi.fn(), info: vi.fn(), error: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({ query: mocks.query, getPool: () => ({ query: mocks.query }) }));
vi.mock('../../src/db/identity-db.js', () => ({ withActiveCredentialEventMutation: mocks.lifecycle }));
vi.mock('../../src/logger.js', () => {
  const logger = { info: mocks.info, error: mocks.error, debug: vi.fn(), warn: vi.fn() };
  return { logger, createLogger: () => logger };
});
vi.mock('../../src/slack/client.js', () => ({
  getSlackUsers: mocks.getSlackUsers, getUserChannels: mocks.getUserChannels,
  getChannelMembers: vi.fn(), getSlackUser: vi.fn(), getChannelInfo: vi.fn(),
  isSlackConfigured: () => true, testSlackConnection: vi.fn(),
}));
vi.mock('../../src/db/working-group-db.js', () => ({ WorkingGroupDatabase: class {
  listWorkingGroupsWithSlackChannel = mocks.chapterWrite;
  addMembershipWithInterest = mocks.chapterWrite;
} }));
vi.mock('../../src/db/addie-db.js', () => ({ AddieDatabase: class {} }));
vi.mock('../../src/db/email-preferences-db.js', () => ({ EmailPreferencesDatabase: class {
  setMarketingOptInIfNotSet = mocks.preferenceWrite;
} }));
vi.mock('../../src/cache/unified-users.js', () => ({ invalidateUnifiedUsersCache: mocks.unifiedCache }));
vi.mock('../../src/addie/index.js', () => ({ invalidateMemberContextCache: mocks.memberCache }));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  invalidateAdminStatusCache: mocks.adminCache, invalidateWebAdminStatusCache: mocks.webAdminCache,
}));
vi.mock('../../src/auth/workos-client.js', () => ({ getWorkos: mocks.workos }));
vi.mock('../../src/notifications/welcome-social-posts.js', () => ({ sendWelcomeSocialPosts: mocks.welcome }));
vi.mock('../../src/notifications/marketing-optin-dm.js', () => ({ sendMarketingOptInDM: mocks.marketing }));
vi.mock('../../src/services/prospect-triage.js', () => ({ triageAndCreateProspect: mocks.prospect }));
vi.mock('../../src/middleware/auth.js', () => ({ requireGlobalAdmin: [
  (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: string } }).user = { id: 'user_admin' };
    next();
  },
] }));

import { SlackDatabase } from '../../src/db/slack-db.js';
import { SlackEmailAutoLinkContainedError } from '../../src/slack/email-auto-containment.js';
import { autoLinkUnmappedSlackUsers, tryAutoLinkWebsiteUserToSlack } from '../../src/slack/sync.js';
import { handleTeamJoin } from '../../src/slack/events.js';
import { createAdminSlackRouter } from '../../src/routes/admin/slack.js';

const mapping = {
  slack_user_id: 'U_SAM', slack_email: 'sam@pinnacle.example', slack_real_name: 'Sam Adeyemi',
  workos_user_id: null, mapping_status: 'unmapped', slack_is_bot: false, slack_is_deleted: false,
  pending_marketing_opt_in: true,
};
const input = { slack_user_id: 'U_SAM', workos_user_id: 'user_sam', mapping_source: 'email_auto' as const };
const bulkResult = { linked: 0, chapters_joined: 0, organizations_assigned: 0,
  pending_org_prospects_set: 0, contained: 1, errors: 0 };

function assertNoLinkSideEffects() {
  for (const spy of [mocks.lifecycle, mocks.getSlackUsers, mocks.getUserChannels,
    mocks.chapterWrite, mocks.preferenceWrite, mocks.unifiedCache, mocks.memberCache,
    mocks.adminCache, mocks.webAdminCache, mocks.workos, mocks.welcome, mocks.marketing, mocks.prospect]) {
    expect(spy).not.toHaveBeenCalled();
  }
  expect(mocks.query.mock.calls.filter(([sql]) => /\b(UPDATE|INSERT|DELETE)\b/i.test(sql))).toEqual([]);
  expect(mocks.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Auto-(linked|mapped)/));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.query.mockImplementation(async (sql: string) => {
    if (/\b(UPDATE|INSERT|DELETE)\b/i.test(sql)) throw new Error(`Unexpected write: ${sql}`);
    if (sql.includes('FROM organization_memberships')) return { rows: [{ workos_user_id: 'user_sam', email: mapping.slack_email }] };
    if (sql.includes('WHERE workos_user_id =') || sql.includes('SELECT workos_user_id')) return { rows: [] };
    return { rows: [{ ...mapping }] };
  });
});

describe('Slack email-auto database containment', () => {
  it.each([false, true])('rejects before lifecycle entry or any query (external client: %s)', async (external) => {
    const externalQuery = vi.fn();
    const client = external ? { query: externalQuery } as unknown as PoolClient : undefined;
    for (let i = 0; i < 3; i++) {
      const attempt = new SlackDatabase().mapUser(input, client);
      await expect(attempt).rejects.toBeInstanceOf(SlackEmailAutoLinkContainedError);
      await expect(attempt).rejects.toMatchObject({ code: 'slack_email_auto_linking_disabled' });
    }
    expect(mocks.query).not.toHaveBeenCalled();
    expect(externalQuery).not.toHaveBeenCalled();
    assertNoLinkSideEffects();
  });

  it.each(['manual_admin', 'user_claimed'] as const)('keeps %s lifecycle-fenced mapping and name backfill', async (source) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ...mapping, workos_user_id: 'user_sam' }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.lifecycle.mockImplementation(async (_id, mutation) => ({ applied: true, value: await mutation({ query }) }));
    expect(await new SlackDatabase().mapUser({ ...input, mapping_source: source })).toMatchObject({ workos_user_id: 'user_sam' });
    expect(mocks.lifecycle).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(['user_sam', source, null, 'U_SAM']);
    expect(query.mock.calls[1][1]).toEqual(['Sam', 'Adeyemi', 'user_sam']);
  });
});

describe('email-auto callers', () => {
  it('returns the stable no-op from website linking repeatedly', async () => {
    for (let i = 0; i < 3; i++) expect(await tryAutoLinkWebsiteUserToSlack('user_sam', mapping.slack_email))
      .toEqual({ linked: false, reason: 'slack_email_auto_linking_disabled' });
    assertNoLinkSideEffects();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('contains team_join before profile writes, preference transfer, chapter sync or prospect work', async () => {
    for (let i = 0; i < 3; i++) expect(await handleTeamJoin({ type: 'team_join', user: {
      id: 'U_SAM', name: 'sam', is_bot: false, deleted: false,
      profile: { email: mapping.slack_email, real_name: 'Sam Adeyemi' },
    } })).toBe('contained');
    assertNoLinkSideEffects();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('counts repeated bulk attempts as contained, with no refresh, backfill or success counters', async () => {
    for (let i = 0; i < 3; i++) expect(await autoLinkUnmappedSlackUsers()).toEqual(bulkResult);
    assertNoLinkSideEffects();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('returns contained counts with HTTP 200 from admin bulk API', async () => {
    const app = express().use(express.json()).use('/api/admin/slack', createAdminSlackRouter());
    for (let i = 0; i < 2; i++) {
      const result = await request(app).post('/api/admin/slack/auto-link-suggested');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ...bulkResult, errors: [] });
    }
    assertNoLinkSideEffects();
  });

  it('keeps standalone admin profile sync separate and never maps users', async () => {
    mocks.getSlackUsers.mockResolvedValue([]);
    const map = vi.spyOn(SlackDatabase.prototype, 'mapUser');
    const app = express().use('/api/admin/slack', createAdminSlackRouter());
    const result = await request(app).post('/api/admin/slack/sync');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ total_synced: 0, auto_mapped: 0, errors: [] });
    expect(map).not.toHaveBeenCalled();
    expect(mocks.workos).not.toHaveBeenCalled();
  });

  it('reports infrastructure failures separately from containment', async () => {
    vi.spyOn(SlackDatabase.prototype, 'mapUser').mockRejectedValue(new Error('database unavailable'));
    expect(await tryAutoLinkWebsiteUserToSlack('user_sam', mapping.slack_email)).toEqual({ linked: false, reason: 'error' });
    expect(await autoLinkUnmappedSlackUsers()).toEqual({ ...bulkResult, contained: 0, errors: 1 });
    assertNoLinkSideEffects();
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });

  it.each(['user_sam', 'user_jordan'])('preserves existing mappings to %s', async (existingId) => {
    vi.spyOn(SlackDatabase.prototype, 'findByEmail').mockResolvedValue({ ...mapping, workos_user_id: existingId } as never);
    vi.spyOn(SlackDatabase.prototype, 'getByWorkosUserId').mockResolvedValue({ ...mapping, workos_user_id: existingId } as never);
    expect(await tryAutoLinkWebsiteUserToSlack('user_sam', mapping.slack_email)).toMatchObject({ linked: false });
    assertNoLinkSideEffects();
  });
});
