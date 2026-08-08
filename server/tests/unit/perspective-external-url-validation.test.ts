import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  isAdmin: vi.fn().mockResolvedValue(false),
  notifyPublishedPost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_editor', email: 'editor@example.test' };
    next();
  },
}));

vi.mock('../../src/middleware/rate-limit.js', () => ({
  contentProposeRateLimiter: (_req: any, _res: any, next: any) => next(),
  contentFetchUrlRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: (...args: unknown[]) => mocks.isAdmin(...args),
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/notifications/slack.js', () => ({
  notifyPublishedPost: (...args: unknown[]) => mocks.notifyPublishedPost(...args),
  sendSocialAmplificationDM: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getEditorialChannel: vi.fn().mockResolvedValue({ channel_id: null }),
}));

vi.mock('../../src/addie/services/journey-computation.js', () => ({
  computeJourneyStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/community-db.js', () => ({
  CommunityDatabase: class {
    awardPoints = vi.fn().mockResolvedValue(undefined);
    checkAndAwardBadges = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../src/db/perspective-asset-db.js', () => ({
  createAsset: vi.fn(),
}));

vi.mock('../../src/services/posthog-query.js', () => ({
  fetchPathPageviewCounts: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../src/utils/url-security.js', () => ({
  safeFetch: vi.fn(),
}));

vi.mock('../../src/services/illustration-generator.js', () => ({
  generateIllustration: vi.fn(),
}));

vi.mock('../../src/db/illustration-db.js', () => ({
  createIllustration: vi.fn(),
  approveIllustration: vi.fn(),
}));

vi.mock('../../src/db/escalation-db.js', () => ({
  resolveEscalationsForPerspective: vi.fn(),
}));

vi.mock('../../src/services/my-content-service.js', () => ({
  listMyContent: vi.fn().mockResolvedValue({ items: [] }),
  MyContentError: class extends Error {
    is() { return false; }
    meta = { valid: [] };
  },
}));

vi.mock('../../src/services/membership-tiers.js', () => ({
  checkContentSubmissionTier: vi.fn().mockResolvedValue(true),
}));

import {
  createMyContentRouter,
  proposeContentForUser,
} from '../../src/routes/content.js';

const SAFE_URL = 'https://partner.example/field-notes';
const NON_CANONICAL_URL = 'https://Partner.Example:443/field notes?q=(roundup)';
const CANONICAL_URL = 'https://partner.example/field%20notes?q=(roundup)';

function proposal(externalUrl: string, status: 'draft' | 'published' = 'draft') {
  return proposeContentForUser(
    { id: 'system:perspective-url-regression', email: 'system@example.test' },
    {
      title: 'External field notes',
      content_type: 'link',
      external_url: externalUrl,
      collection: { slug: 'security-testing' },
      status,
    },
  );
}

function existingLinkPerspective() {
  return {
    id: 'perspective_test',
    slug: 'external-field-notes',
    title: 'External field notes',
    content: null,
    content_type: 'link',
    excerpt: null,
    external_url: 'https://partner.example/original',
    external_site_name: 'Partner',
    category: 'Perspective',
    tags: [],
    author_name: 'Editor',
    author_user_id: 'user_editor',
    content_origin: 'member',
    proposer_user_id: 'user_editor',
    working_group_id: null,
    status: 'draft',
  };
}

function mountMyContentRouter() {
  const app = express();
  app.use(express.json());
  app.use('/content', createMyContentRouter());
  return app;
}

describe('perspective external URL persistence validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdmin.mockResolvedValue(false);
  });

  it.each([
    'javascript:globalThis.__perspectiveXss = true',
    'data:text/html,<script>globalThis.__perspectiveXss = true</script>',
    'http://partner.example/article',
    'https://attacker:secret@partner.example/article',
    '\thttps://partner.example/article',
    'https://partner.example/article\r\n- [Injected](https://attacker.example)',
    'https://partner.example/article\u007F',
  ])('rejects an unsafe URL before proposal persistence: %s', async (externalUrl) => {
    const result = await proposal(externalUrl);

    expect(result).toEqual({
      success: false,
      error: 'external_url must be an HTTPS URL without credentials',
    });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('persists a valid HTTPS URL through the proposal service', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM working_groups')) {
        return {
          rows: [{
            id: 'wg_security',
            name: 'Security testing',
            accepts_public_submissions: true,
            slack_channel_id: null,
          }],
        };
      }
      if (sql.includes('FROM working_group_leaders')) return { rows: [] };
      if (sql.includes('SELECT first_name, last_name, email FROM users')) {
        return { rows: [{ first_name: 'System', last_name: 'Editor', email: 'system@example.test' }] };
      }
      if (sql.includes('INSERT INTO perspectives')) {
        return {
          rows: [{
            id: 'perspective_created',
            slug: 'external-field-notes-created',
            title: 'External field notes',
            content_type: 'link',
            content: null,
            excerpt: null,
            category: null,
            external_url: values?.[6],
            proposed_at: new Date().toISOString(),
            status: 'draft',
          }],
        };
      }
      if (sql.includes('FROM organization_memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO content_authors')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await proposal(SAFE_URL);

    expect(result.success).toBe(true);
    const insertCall = mocks.poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO perspectives'));
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toContain(SAFE_URL);
  });

  it('persists the canonical href through the proposal service', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM working_groups')) {
        return { rows: [{ id: 'wg_security', name: 'Security testing', accepts_public_submissions: true, slack_channel_id: null }] };
      }
      if (sql.includes('FROM working_group_leaders')) return { rows: [{}] };
      if (sql.includes('SELECT first_name, last_name, email FROM users')) return { rows: [] };
      if (sql.includes('INSERT INTO perspectives')) return { rows: [{ id: 'perspective_created', external_url: values?.[6] }] };
      if (sql.includes('FROM organization_memberships')) return { rows: [] };
      if (sql.includes('INSERT INTO content_authors')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(proposal(NON_CANONICAL_URL, 'published')).resolves.toMatchObject({ success: true });
    const insert = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO perspectives'));
    expect(insert?.[1]?.[6]).toBe(CANONICAL_URL);
    expect(mocks.notifyPublishedPost).toHaveBeenCalledWith(expect.objectContaining({
      externalUrl: CANONICAL_URL,
    }));
  });

  it.each([
    'javascript:globalThis.__perspectiveXss = true',
    'data:text/html,<script>globalThis.__perspectiveXss = true</script>',
    'http://partner.example/article',
    'https://attacker:secret@partner.example/article',
    '\thttps://partner.example/article',
    'https://partner.example/article\n',
    'https://partner.example/article\u007F',
  ])('rejects an unsafe URL before the content update query: %s', async (externalUrl) => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT p.*')) return { rows: [existingLinkPerspective()] };
      if (sql.includes('SELECT 1 FROM content_authors')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const response = await request(mountMyContentRouter())
      .put('/content/perspective_test')
      .send({ external_url: externalUrl });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid external URL');
    expect(mocks.poolQuery.mock.calls.some(([sql]) =>
      String(sql).includes('UPDATE perspectives'))).toBe(false);
  });

  it('persists a valid HTTPS URL through the content update route', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT p.*')) return { rows: [existingLinkPerspective()] };
      if (sql.includes('SELECT 1 FROM content_authors')) return { rows: [] };
      if (sql.includes('UPDATE perspectives SET')) {
        return { rows: [{ ...existingLinkPerspective(), external_url: values?.[0] }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const response = await request(mountMyContentRouter())
      .put('/content/perspective_test')
      .send({ external_url: SAFE_URL });

    expect(response.status).toBe(200);
    expect(response.body.external_url).toBe(SAFE_URL);
    const updateCall = mocks.poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE perspectives SET'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toContain(SAFE_URL);
  });

  it('persists the canonical href through the content update route', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT p.*')) return { rows: [existingLinkPerspective()] };
      if (sql.includes('SELECT 1 FROM content_authors')) return { rows: [] };
      if (sql.includes('UPDATE perspectives SET')) {
        return { rows: [{ ...existingLinkPerspective(), external_url: values?.[0] }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const response = await request(mountMyContentRouter())
      .put('/content/perspective_test')
      .send({ external_url: NON_CANONICAL_URL });

    expect(response.status).toBe(200);
    expect(response.body.external_url).toBe(CANONICAL_URL);
    const update = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE perspectives SET'));
    expect(update?.[1]?.[0]).toBe(CANONICAL_URL);
  });
});
