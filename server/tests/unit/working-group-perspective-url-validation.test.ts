import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  getGroup: vi.fn(),
  isMember: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
  query: vi.fn(),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupBySlug = (...args: unknown[]) => mocks.getGroup(...args);
    isMember = (...args: unknown[]) => mocks.isMember(...args);
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_author', email: 'author@example.test', firstName: 'Test', lastName: 'Author' };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireGlobalAdmin: [(_req: any, _res: any, next: any) => next()],
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  createRequireWorkingGroupLeader: () => (_req: any, _res: any, next: any) => next(),
  createRequireWorkingGroupMember: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/notifications/slack.js', () => ({
  notifyPublishedPost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/slack/client.js', () => ({
  createChannel: vi.fn(),
  setChannelPurpose: vi.fn(),
  sendChannelMessage: vi.fn(),
  inviteToChannel: vi.fn(),
  isSlackConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));
vi.mock('../../src/addie/jobs/committee-document-indexer.js', () => ({ reindexDocument: vi.fn() }));
vi.mock('../../src/addie/mcp/docs-indexer.js', () => ({ refreshWorkingGroupDocs: vi.fn() }));
vi.mock('../../src/addie/index.js', () => ({ invalidateMemberContextCache: vi.fn() }));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  invalidateWebAdminStatusCache: vi.fn(),
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/slack/sync.js', () => ({
  syncWorkingGroupMembersFromSlack: vi.fn(),
  syncAllWorkingGroupMembersFromSlack: vi.fn(),
}));
vi.mock('../../src/notifications/notification-service.js', () => ({ notifyUser: vi.fn() }));
vi.mock('../../src/db/events-db.js', () => ({ eventsDb: {} }));
vi.mock('../../src/db/community-db.js', () => ({ CommunityDatabase: class {} }));
vi.mock('../../src/slack/db.js', () => ({ SlackDatabase: class {} }));
vi.mock('../../src/addie/services/wg-welcome.js', () => ({ sendWgWelcomeMessage: vi.fn() }));
vi.mock('../../src/services/working-group-membership-service.js', () => ({
  MASTERMIND_COUNCIL_MEMBERSHIP_NOTICE: 'Our Mastermind Councils are for paying member tiers only. AgenticAdvertising.org membership starts at $50 annually.',
  joinWorkingGroup: vi.fn(),
  expressCommitteeInterest: vi.fn(),
  withdrawCommitteeInterest: vi.fn(),
  listMyWorkingGroups: vi.fn(),
  listMyCommitteeInterests: vi.fn(),
  WorkingGroupMembershipError: class extends Error {
    is() { return false; }
  },
}));

import { createCommitteeRouters } from '../../src/routes/committees.js';
import {
  createWorkingGroupPost,
  WorkingGroupContentError,
} from '../../src/services/working-group-content-service.js';

const SAFE_URL = 'https://partner.example/field-notes';
const NON_CANONICAL_URL = 'https://Partner.Example:443/field notes?q=(roundup)';
const CANONICAL_URL = 'https://partner.example/field%20notes?q=(roundup)';
const UNSAFE_URLS = [
  'javascript:globalThis.__perspectiveXss = true',
  'data:text/html,<script>globalThis.__perspectiveXss = true</script>',
  'http://partner.example/article',
  'https://attacker:secret@partner.example/article',
  '\thttps://partner.example/article',
  'https://partner.example/article\r\n- [Injected](https://attacker.example)',
  'https://partner.example/article\u007F',
];

const group = {
  id: 'wg_security',
  slug: 'security',
  name: 'Security',
  status: 'active',
  leaders: [{ canonical_user_id: 'user_author' }],
  slack_channel_id: null,
};

function mountRouter() {
  const app = express();
  app.use(express.json());
  app.use('/working-groups', createCommitteeRouters().publicApiRouter);
  return app;
}

function existingPost() {
  return {
    id: 'post_1',
    slug: 'field-notes',
    content_type: 'link',
    title: 'Field notes',
    content: null,
    category: null,
    excerpt: null,
    external_url: SAFE_URL,
    external_site_name: 'Partner',
    author_user_id: 'user_author',
    is_members_only: true,
    status: 'draft',
    published_at: null,
  };
}

describe('working-group perspective external URL validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGroup.mockResolvedValue(group);
    mocks.isMember.mockResolvedValue(true);
  });

  it.each(UNSAFE_URLS)('rejects unsafe URLs in the shared create service before persistence: %s', async (externalUrl) => {
    await expect(createWorkingGroupPost({
      user: { id: 'user_author', email: 'author@example.test' },
      slug: 'security',
      title: 'Field notes',
      postSlug: 'field-notes',
      contentType: 'link',
      externalUrl,
    })).rejects.toMatchObject<Partial<WorkingGroupContentError>>({ code: 'invalid_external_url' });

    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('persists a valid HTTPS URL through the shared create service', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ ...existingPost(), external_url: SAFE_URL }] });

    await createWorkingGroupPost({
      user: { id: 'user_author', email: 'author@example.test' },
      slug: 'security',
      title: 'Field notes',
      postSlug: 'field-notes',
      contentType: 'link',
      externalUrl: SAFE_URL,
    });

    const insert = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO perspectives'));
    expect(insert?.[1]).toContain(SAFE_URL);
  });

  it.each(UNSAFE_URLS)('rejects unsafe URLs in the member update path before persistence: %s', async (externalUrl) => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM perspectives')) return { rows: [existingPost()] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const response = await request(mountRouter())
      .put('/working-groups/security/posts/post_1')
      .send({ external_url: externalUrl });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid external URL');
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE perspectives'))).toBe(false);
  });

  it.each([
    ['switches a link post to an article', { ...existingPost(), content_type: 'link' }, { content_type: 'article', external_url: null }],
    ['clears an article URL', { ...existingPost(), content_type: 'article' }, { external_url: null }],
  ])('%s while persisting an explicit null URL', async (_label, post, body) => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM perspectives')) return { rows: [post] };
      if (sql.includes('UPDATE perspectives')) {
        return { rows: [{ ...post, ...body }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await request(mountRouter())
      .put('/working-groups/security/posts/post_1')
      .send(body)
      .expect(200);

    const update = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE perspectives'));
    expect(update?.[1]?.[6]).toBeNull();
  });

  it.each(UNSAFE_URLS)('rejects unsafe URLs in leader create and update paths: %s', async (externalUrl) => {
    const createResponse = await request(mountRouter())
      .post('/working-groups/security/manage/posts')
      .send({ post_slug: 'field-notes', title: 'Field notes', content_type: 'link', external_url: externalUrl });

    expect(createResponse.status).toBe(400);
    expect(createResponse.body.error).toBe('Invalid external URL');
    expect(mocks.poolQuery).not.toHaveBeenCalled();

    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM perspectives')) return { rows: [existingPost()] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const updateResponse = await request(mountRouter())
      .put('/working-groups/security/manage/posts/post_1')
      .send({ external_url: externalUrl });

    expect(updateResponse.status).toBe(400);
    expect(updateResponse.body.error).toBe('Invalid external URL');
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE perspectives'))).toBe(false);
  });

  it('persists valid HTTPS controls through member update and leader create/update', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT * FROM perspectives')) return { rows: [existingPost()] };
      if (sql.includes('INSERT INTO perspectives')) {
        const externalUrlIndex = sql.includes('subtitle') ? 8 : 7;
        return { rows: [{ ...existingPost(), external_url: values?.[externalUrlIndex] }] };
      }
      if (sql.includes('UPDATE perspectives')) return { rows: [{ ...existingPost(), external_url: SAFE_URL }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const memberUpdate = await request(mountRouter())
      .put('/working-groups/security/posts/post_1')
      .send({ external_url: SAFE_URL });
    expect(memberUpdate.status).toBe(200);

    const leaderCreate = await request(mountRouter())
      .post('/working-groups/security/manage/posts')
      .send({ post_slug: 'field-notes', title: 'Field notes', content_type: 'link', external_url: SAFE_URL });
    expect(leaderCreate.status).toBe(201);

    const leaderUpdate = await request(mountRouter())
      .put('/working-groups/security/manage/posts/post_1')
      .send({ external_url: SAFE_URL });
    expect(leaderUpdate.status).toBe(200);

    expect(mocks.poolQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE perspectives'))).toHaveLength(2);
    expect(mocks.poolQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO perspectives'))).toHaveLength(1);
  });

  it('persists canonical hrefs through every working-group writer', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT * FROM perspectives')) return { rows: [existingPost()] };
      if (sql.includes('INSERT INTO perspectives')) return { rows: [{ ...existingPost(), external_url: values?.[8] }] };
      if (sql.includes('UPDATE perspectives')) {
        const externalUrlIndex = sql.includes('external_url = $7') ? 6 : 7;
        return { rows: [{ ...existingPost(), external_url: values?.[externalUrlIndex] }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await createWorkingGroupPost({
      user: { id: 'user_author', email: 'author@example.test' },
      slug: 'security',
      title: 'Field notes',
      postSlug: 'field-notes',
      contentType: 'link',
      externalUrl: NON_CANONICAL_URL,
    });
    const memberUpdate = await request(mountRouter())
      .put('/working-groups/security/posts/post_1')
      .send({ external_url: NON_CANONICAL_URL });
    const leaderCreate = await request(mountRouter())
      .post('/working-groups/security/manage/posts')
      .send({ post_slug: 'field-notes', title: 'Field notes', content_type: 'link', external_url: NON_CANONICAL_URL });
    const leaderUpdate = await request(mountRouter())
      .put('/working-groups/security/manage/posts/post_1')
      .send({ external_url: NON_CANONICAL_URL });

    expect(memberUpdate.status).toBe(200);
    expect(leaderCreate.status).toBe(201);
    expect(leaderUpdate.status).toBe(200);
    const writes = mocks.poolQuery.mock.calls.filter(([sql]) => /(?:INSERT INTO|UPDATE) perspectives/.test(String(sql)));
    expect(writes).toHaveLength(4);
    expect(writes.map(([sql, values]) => {
      if (String(sql).includes('INSERT INTO perspectives')) return values?.[String(sql).includes('subtitle') ? 8 : 7];
      return String(sql).includes('external_url = $7') ? values?.[6] : values?.[7];
    })).toEqual([CANONICAL_URL, CANONICAL_URL, CANONICAL_URL, CANONICAL_URL]);
  });
});
