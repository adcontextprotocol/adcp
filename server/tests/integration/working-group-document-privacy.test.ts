import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/middleware/auth.js', () => {
  const optionalAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const identity = req.header('x-test-user');
    if (identity) {
      req.user = { id: identity, email: `${identity}@example.com` } as Express.Request['user'];
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
  isWebUserAAOAdmin: vi.fn(async (userId: string) => userId === 'privacy-admin'),
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

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createCommitteeRouters } from '../../src/routes/committees.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';
const suffix = `privacy-${process.pid}-${Date.now()}`;
const slugs = {
  public: `${suffix}-public`,
  private: `${suffix}-private`,
  archived: `${suffix}-archived`,
};

const users = {
  active: `${suffix}-active`,
  inactive: `${suffix}-inactive`,
  pending: `${suffix}-pending`,
  outsider: `${suffix}-outsider`,
  leader: `${suffix}-leader`,
  admin: 'privacy-admin',
};

const fileBytes = Buffer.from('private file bytes\n');
const assetBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('working-group document privacy with migrated database', () => {
  let pool: Pool;
  let app: express.Express;
  let publicGroupId: string;
  let privateGroupId: string;
  let archivedGroupId: string;
  let publicDocumentId: string;
  let privateDocumentId: string;
  let archivedDocumentId: string;
  let publicAssetId: string;
  let privateAssetId: string;
  let archivedAssetId: string;
  let inconsistentAssetId: string;

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: databaseUrl });
    await runMigrations();

    const groups = await pool.query<{ id: string; slug: string }>(
      `INSERT INTO working_groups (name, slug, is_private, status)
       VALUES
         ('Privacy public', $1, false, 'active'),
         ('Privacy private', $2, true, 'active'),
         ('Privacy archived', $3, true, 'archived')
       RETURNING id, slug`,
      [slugs.public, slugs.private, slugs.archived],
    );
    publicGroupId = groups.rows.find(row => row.slug === slugs.public)!.id;
    privateGroupId = groups.rows.find(row => row.slug === slugs.private)!.id;
    archivedGroupId = groups.rows.find(row => row.slug === slugs.archived)!.id;

    const documents = await pool.query<{ id: string; working_group_id: string }>(
      `INSERT INTO committee_documents
         (working_group_id, title, document_url, document_type, document_summary,
          index_status, file_data, file_name, file_mime_type)
       VALUES
         ($1, 'Public document', 'https://example.com/public', 'pdf', 'Public document summary',
          'success', $4, 'public.pdf', 'application/pdf'),
         ($2, 'Private document', 'https://example.com/private', 'pdf', 'Private document summary',
          'success', $5, 'private.pdf', 'application/pdf'),
         ($3, 'Archived document', 'https://example.com/archived', 'pdf', 'Archived document summary',
          'success', $6, 'archived.pdf', 'application/pdf')
       RETURNING id, working_group_id`,
      [publicGroupId, privateGroupId, archivedGroupId, Buffer.from('public file'), fileBytes, Buffer.from('archived file')],
    );
    publicDocumentId = documents.rows.find(row => row.working_group_id === publicGroupId)!.id;
    privateDocumentId = documents.rows.find(row => row.working_group_id === privateGroupId)!.id;
    archivedDocumentId = documents.rows.find(row => row.working_group_id === archivedGroupId)!.id;

    await pool.query(
      `INSERT INTO committee_summaries (working_group_id, summary_type, summary_text)
       VALUES ($1, 'activity', 'Public group summary'),
              ($2, 'activity', 'Private group summary'),
              ($3, 'activity', 'Archived group summary')`,
      [publicGroupId, privateGroupId, archivedGroupId],
    );
    await pool.query(
      `INSERT INTO committee_document_activity
         (document_id, working_group_id, activity_type, change_summary)
       VALUES ($1, $2, 'content_changed', 'Public activity'),
              ($3, $4, 'content_changed', 'Private activity'),
              ($5, $6, 'content_changed', 'Archived activity')`,
      [publicDocumentId, publicGroupId, privateDocumentId, privateGroupId, archivedDocumentId, archivedGroupId],
    );

    const assets = await pool.query<{ id: string; working_group_id: string; filename: string }>(
      `INSERT INTO committee_document_assets
         (document_id, working_group_id, filename, mime_type, file_size, asset_data, extraction_order)
       VALUES
         ($1, $2, 'public.png', 'image/png', 4, $7, 0),
         ($3, $4, 'private.png', 'image/png', $8, $9, 0),
         ($5, $6, 'archived.png', 'image/png', 4, $10, 0),
         ($3, $2, 'inconsistent.png', 'image/png', 4, $11, 1)
       RETURNING id, working_group_id, filename`,
      [
        publicDocumentId, publicGroupId,
        privateDocumentId, privateGroupId,
        archivedDocumentId, archivedGroupId,
        Buffer.from('pub'), assetBytes.length, assetBytes,
        Buffer.from('arch'), Buffer.from('bad!'),
      ],
    );
    publicAssetId = assets.rows.find(row => row.filename === 'public.png')!.id;
    privateAssetId = assets.rows.find(row => row.filename === 'private.png')!.id;
    archivedAssetId = assets.rows.find(row => row.filename === 'archived.png')!.id;
    inconsistentAssetId = assets.rows.find(row => row.filename === 'inconsistent.png')!.id;

    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       VALUES ($1, $2, 'active'), ($1, $3, 'inactive'), ($4, $2, 'active')`,
      [privateGroupId, users.active, users.inactive, archivedGroupId],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)`,
      [privateGroupId, users.leader],
    );

    app = express();
    app.use('/api/working-groups', createCommitteeRouters().publicApiRouter);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM working_groups WHERE slug = ANY($1::text[])', [Object.values(slugs)]);
    }
    await closeDatabase();
  });

  function privateReadPaths() {
    return [
      `/api/working-groups/${slugs.private}/documents`,
      `/api/working-groups/${slugs.private}/activity`,
      `/api/working-groups/${slugs.private}/summary`,
      `/api/working-groups/${slugs.private}/documents/${privateDocumentId}/file`,
      `/api/working-groups/${slugs.private}/documents/${privateDocumentId}/assets`,
      `/api/working-groups/assets/${privateAssetId}`,
    ];
  }

  it.each([
    ['anonymous', undefined],
    ['outsider', users.outsider],
    ['pending applicant', users.pending],
    ['inactive member', users.inactive],
    ['non-member leader', users.leader],
    ['AAO admin', users.admin],
  ])('hides every private document read from an %s', async (_label, userId) => {
    for (const path of privateReadPaths()) {
      const call = request(app).get(path);
      if (userId) call.set('x-test-user', userId);
      await call.expect(404);
    }
  });

  it('does not admit a pending membership state as direct membership', async () => {
    await expect(pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       VALUES ($1, $2, 'pending')`,
      [privateGroupId, users.pending],
    )).rejects.toMatchObject({ code: '23514' });

    await request(app)
      .get(`/api/working-groups/${slugs.private}/documents`)
      .set('x-test-user', users.pending)
      .expect(404);
  });

  it('returns exact private metadata, summaries, file bytes, and assets to an active direct member', async () => {
    const documents = await request(app)
      .get(`/api/working-groups/${slugs.private}/documents`)
      .set('x-test-user', users.active)
      .expect(200);
    expect(documents.body.documents).toEqual([
      expect.objectContaining({
        id: privateDocumentId,
        title: 'Private document',
        document_summary: 'Private document summary',
      }),
    ]);

    const activity = await request(app)
      .get(`/api/working-groups/${slugs.private}/activity`)
      .set('x-test-user', users.active)
      .expect(200);
    expect(activity.body.activity).toEqual([
      expect.objectContaining({ document_id: privateDocumentId, change_summary: 'Private activity' }),
    ]);

    const summary = await request(app)
      .get(`/api/working-groups/${slugs.private}/summary`)
      .set('x-test-user', users.active)
      .expect(200);
    expect(summary.body.summary).toEqual(expect.objectContaining({ summary_text: 'Private group summary' }));

    const file = await request(app)
      .get(`/api/working-groups/${slugs.private}/documents/${privateDocumentId}/file`)
      .set('x-test-user', users.active)
      .expect(200)
      .expect('content-type', 'application/pdf')
      .expect('cache-control', 'private, no-cache')
      .expect('x-content-type-options', 'nosniff')
      .expect('content-security-policy', "default-src 'none'");
    expect(file.body).toEqual(fileBytes);

    const assets = await request(app)
      .get(`/api/working-groups/${slugs.private}/documents/${privateDocumentId}/assets`)
      .set('x-test-user', users.active)
      .expect(200);
    expect(assets.body).toEqual([
      expect.objectContaining({
        id: privateAssetId,
        filename: 'private.png',
        url: `/api/working-groups/assets/${privateAssetId}`,
      }),
    ]);

    const asset = await request(app)
      .get(`/api/working-groups/assets/${privateAssetId}`)
      .set('x-test-user', users.active)
      .expect(200)
      .expect('content-type', 'image/png')
      .expect('cache-control', 'private, no-cache')
      .expect('x-content-type-options', 'nosniff')
      .expect('content-security-policy', "default-src 'none'");
    expect(asset.body).toEqual(assetBytes);
  });

  it('preserves anonymous reads and public caching for every public document surface', async () => {
    await request(app).get(`/api/working-groups/${slugs.public}/documents`).expect(200);
    await request(app).get(`/api/working-groups/${slugs.public}/activity`).expect(200);
    await request(app).get(`/api/working-groups/${slugs.public}/summary`).expect(200);
    await request(app)
      .get(`/api/working-groups/${slugs.public}/documents/${publicDocumentId}/file`)
      .expect(200)
      .expect('cache-control', 'private, no-cache');
    const assets = await request(app)
      .get(`/api/working-groups/${slugs.public}/documents/${publicDocumentId}/assets`)
      .expect(200);
    expect(assets.body).toHaveLength(1);
    await request(app)
      .get(`/api/working-groups/assets/${publicAssetId}`)
      .expect(200)
      .expect('cache-control', 'public, max-age=86400');
  });

  it('hides all archived-group document surfaces even from an active direct member', async () => {
    const paths = [
      `/api/working-groups/${slugs.archived}/documents`,
      `/api/working-groups/${slugs.archived}/activity`,
      `/api/working-groups/${slugs.archived}/summary`,
      `/api/working-groups/${slugs.archived}/documents/${archivedDocumentId}/file`,
      `/api/working-groups/${slugs.archived}/documents/${archivedDocumentId}/assets`,
      `/api/working-groups/assets/${archivedAssetId}`,
    ];
    for (const path of paths) {
      await request(app).get(path).set('x-test-user', users.active).expect(404);
    }
  });

  it('binds file and asset-list reads to both document ID and requested group', async () => {
    await request(app)
      .get(`/api/working-groups/${slugs.public}/documents/${privateDocumentId}/file`)
      .expect(404);
    await request(app)
      .get(`/api/working-groups/${slugs.public}/documents/${privateDocumentId}/assets`)
      .expect(404);
  });

  it('rejects denormalized assets whose document and group ownership disagree', async () => {
    const assets = await request(app)
      .get(`/api/working-groups/${slugs.private}/documents/${privateDocumentId}/assets`)
      .set('x-test-user', users.active)
      .expect(200);
    expect(assets.body.map((asset: { id: string }) => asset.id)).not.toContain(inconsistentAssetId);

    await request(app)
      .get(`/api/working-groups/assets/${inconsistentAssetId}`)
      .expect(404);
  });
});
