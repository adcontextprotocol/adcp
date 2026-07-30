import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = {
  document: '11111111-1111-4111-8111-111111111111',
  asset: '22222222-2222-4222-8222-222222222222',
  privateGroup: '33333333-3333-4333-8333-333333333333',
  publicGroup: '44444444-4444-4444-8444-444444444444',
};

const privateGroup = {
  id: ids.privateGroup,
  slug: 'private-group',
  name: 'Private group',
  is_private: true,
  status: 'active',
};

const publicGroup = {
  id: ids.publicGroup,
  slug: 'public-group',
  name: 'Public group',
  is_private: false,
  status: 'active',
};

const db = vi.hoisted(() => ({
  getWorkingGroupBySlug: vi.fn(),
  getWorkingGroupById: vi.fn(),
  isMember: vi.fn(),
  isLeader: vi.fn(),
  getDocumentsByWorkingGroup: vi.fn(),
  getRecentActivity: vi.fn(),
  getCurrentSummary: vi.fn(),
  getDocumentFileData: vi.fn(),
  getDocumentAssetMetadata: vi.fn(),
  getDocumentAssetData: vi.fn(),
  getDocumentById: vi.fn(),
  getDocumentAssets: vi.fn(),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    constructor() {
      return db;
    }
  },
}));

vi.mock('../../src/middleware/auth.js', () => {
  const optionalAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const identity = req.header('x-test-user');
    if (identity) {
      req.user = {
        id: identity,
        email: `${identity}@example.com`,
      } as Express.Request['user'];
    }
    next();
  };
  const passthrough = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  return {
    optionalAuth,
    requireAuth: optionalAuth,
    requireAdmin: passthrough,
    requireGlobalAdmin: [optionalAuth, passthrough, passthrough],
    createRequireWorkingGroupLeader: () => passthrough,
    createRequireWorkingGroupMember: () => passthrough,
  };
});

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  invalidateWebAdminStatusCache: vi.fn(),
  isWebUserAAOAdmin: vi.fn(async (userId: string) => userId === 'admin'),
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

import { createCommitteeRouters } from '../../src/routes/committees.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/working-groups', createCommitteeRouters().publicApiRouter);
  return app;
}

describe('private working-group document reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_EMAILS;

    db.getWorkingGroupBySlug.mockImplementation(async (slug: string) => (
      slug === privateGroup.slug ? privateGroup : slug === publicGroup.slug ? publicGroup : null
    ));
    db.getWorkingGroupById.mockImplementation(async (id: string) => (
      id === privateGroup.id ? privateGroup : id === publicGroup.id ? publicGroup : null
    ));
    db.isMember.mockImplementation(async (_groupId: string, userId: string) => userId === 'member');
    db.isLeader.mockImplementation(async (_groupId: string, userId: string) => userId === 'leader');
    db.getDocumentsByWorkingGroup.mockResolvedValue([{ id: ids.document, title: 'Secret plan' }]);
    db.getRecentActivity.mockResolvedValue([{ document_title: 'Secret plan' }]);
    db.getCurrentSummary.mockResolvedValue({ summary_text: 'Secret summary' });
    db.getDocumentFileData.mockImplementation(async (documentId: string, groupId: string) => (
      documentId === ids.document && groupId === privateGroup.id
        ? {
            file_data: Buffer.from('secret bytes'),
            file_mime_type: 'application/pdf',
            file_name: 'secret.pdf',
          }
        : null
    ));
    db.getDocumentAssetMetadata.mockResolvedValue({
      mime_type: 'image/png',
      working_group_id: privateGroup.id,
    });
    db.getDocumentAssetData.mockResolvedValue({
      asset_data: Buffer.from('image bytes'),
      mime_type: 'image/png',
    });
    db.getDocumentById.mockResolvedValue({ id: ids.document, working_group_id: privateGroup.id });
    db.getDocumentAssets.mockResolvedValue([{ id: ids.asset, filename: 'figure.png' }]);
  });

  it.each([
    ['anonymous caller', undefined],
    ['authenticated non-member', 'outsider'],
  ])('hides private document metadata from an %s', async (_label, userId) => {
    const app = createApp();
    const call = request(app).get('/api/working-groups/private-group/documents');
    if (userId) call.set('x-test-user', userId);

    const response = await call.expect(404);

    expect(response.body).toEqual({
      error: 'Working group not found',
      message: 'No working group found with slug: private-group',
    });
    expect(db.getDocumentsByWorkingGroup).not.toHaveBeenCalled();
  });

  it('allows a direct member to list private documents', async () => {
    const response = await request(createApp())
      .get('/api/working-groups/private-group/documents')
      .set('x-test-user', 'member')
      .expect(200);

    expect(response.body.documents).toEqual([expect.objectContaining({ id: ids.document, title: 'Secret plan' })]);
  });

  it.each(['leader', 'admin'])('does not let a non-member %s bypass private-group visibility', async (userId) => {
    await request(createApp())
      .get('/api/working-groups/private-group/documents')
      .set('x-test-user', userId)
      .expect(404);

    expect(db.getDocumentsByWorkingGroup).not.toHaveBeenCalled();
  });

  it('keeps public document reads anonymous', async () => {
    const response = await request(createApp())
      .get('/api/working-groups/public-group/documents')
      .expect(200);

    expect(response.body.documents).toHaveLength(1);
    expect(db.isMember).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/working-groups/private-group/activity', 'getRecentActivity'],
    ['/api/working-groups/private-group/summary', 'getCurrentSummary'],
    [`/api/working-groups/private-group/documents/${ids.document}/file`, 'getDocumentFileData'],
    [`/api/working-groups/private-group/documents/${ids.document}/assets`, 'getDocumentAssets'],
  ])('blocks a non-member before reading private data at %s', async (path, sink) => {
    await request(createApp())
      .get(path)
      .set('x-test-user', 'outsider')
      .expect(404);

    expect(db[sink as keyof typeof db]).not.toHaveBeenCalled();
  });

  it('serves private summaries, files, and asset metadata to a direct member', async () => {
    const app = createApp();

    await request(app)
      .get('/api/working-groups/private-group/summary')
      .set('x-test-user', 'member')
      .expect(200, { summary: { summary_text: 'Secret summary' } });
    const file = await request(app)
      .get(`/api/working-groups/private-group/documents/${ids.document}/file`)
      .set('x-test-user', 'member')
      .expect(200)
      .expect('content-type', 'application/pdf')
      .expect('cache-control', 'private, no-cache')
      .expect('x-content-type-options', 'nosniff')
      .expect('content-security-policy', "default-src 'none'");
    expect(file.body).toEqual(Buffer.from('secret bytes'));
    expect(db.getDocumentFileData).toHaveBeenCalledWith(ids.document, privateGroup.id);
    await request(app)
      .get(`/api/working-groups/private-group/documents/${ids.document}/assets`)
      .set('x-test-user', 'member')
      .expect(200)
      .expect([{ id: ids.asset, filename: 'figure.png', url: `/api/working-groups/assets/${ids.asset}` }]);
    expect(db.getDocumentAssets).toHaveBeenCalledWith(ids.document, privateGroup.id);
  });

  it('binds file bytes to both the document ID and requested group', async () => {
    await request(createApp())
      .get(`/api/working-groups/public-group/documents/${ids.document}/file`)
      .expect(404, { error: 'No file data available' });

    expect(db.getDocumentFileData).toHaveBeenCalledWith(ids.document, publicGroup.id);
  });

  it('does not allow a public group slug to expose another group document assets', async () => {
    await request(createApp())
      .get(`/api/working-groups/public-group/documents/${ids.document}/assets`)
      .expect(404, { error: 'Document not found' });

    expect(db.getDocumentAssets).not.toHaveBeenCalled();
  });

  it('hides private extracted asset bytes from non-members', async () => {
    const response = await request(createApp())
      .get(`/api/working-groups/assets/${ids.asset}`)
      .set('x-test-user', 'outsider')
      .expect(404);

    expect(response.text).toBe('Asset not found');
    expect(db.getDocumentAssetMetadata).toHaveBeenCalledWith(ids.asset);
    expect(db.getDocumentAssetData).not.toHaveBeenCalled();
  });

  it('serves private extracted assets only with private caching for a member', async () => {
    const response = await request(createApp())
      .get(`/api/working-groups/assets/${ids.asset}`)
      .set('x-test-user', 'member')
      .expect(200)
      .expect('cache-control', 'private, no-cache')
      .expect('content-type', 'image/png')
      .expect('x-content-type-options', 'nosniff')
      .expect('content-security-policy', "default-src 'none'");

    expect(response.body).toEqual(Buffer.from('image bytes'));
    expect(db.getDocumentAssetData).toHaveBeenCalledWith(ids.asset, privateGroup.id);
  });

  it('preserves anonymous serving and public caching for public extracted assets', async () => {
    db.getDocumentAssetMetadata.mockResolvedValue({
      mime_type: 'image/png',
      working_group_id: publicGroup.id,
    });
    db.getDocumentAssetData.mockResolvedValue({ asset_data: Buffer.from('public image'), mime_type: 'image/png' });

    await request(createApp())
      .get(`/api/working-groups/assets/${ids.asset}`)
      .expect(200)
      .expect('cache-control', 'public, max-age=86400');
  });
});
