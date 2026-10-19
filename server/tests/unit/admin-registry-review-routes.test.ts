/**
 * The admin moderation queue for registry submissions (adcp#8338).
 *
 * Since #8337 an inconclusive automated review leaves community records
 * pending and flagged edits live, so these endpoints are the only way to
 * finish that work outside Slack. Three properties matter:
 *
 *  1. **Admin-only, and attributable.** Reads are admin-gated; mutations
 *     additionally refuse API-key callers, because every decision is
 *     recorded against a moderator identity.
 *  2. **The pending guard is an authorization boundary.** `reject` deletes
 *     a record, so it must be reachable only for records that are actually
 *     waiting on review — never for a live, approved registry record.
 *  3. **The revert target comes from the stored item, not the request.**
 *     #8337 fixed the semantics: undoing edit N restores revision N.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  listQueue: vi.fn(),
  getBacklog: vi.fn(),
  getOpenItem: vi.fn(),
  resolveItem: vi.fn(),
  reopenItem: vi.fn(),
  resolveForRecord: vi.fn(),
  getBrand: vi.fn(),
  approveBrand: vi.fn(),
  deleteBrand: vi.fn(),
  rollbackBrand: vi.fn(),
  getProperty: vi.fn(),
  approveProperty: vi.fn(),
  deleteProperty: vi.fn(),
  rollbackProperty: vi.fn(),
  notifyResolved: vi.fn(async () => undefined),
  serveHtml: vi.fn(async (_req: unknown, res: { send: (body: string) => void }) => res.send('<html></html>')),
}));

let currentUser: Record<string, unknown> | null = { id: 'user_mod', email: 'mod@example.com', displayName: 'Mod Erator' };
let isAdmin = true;
let isStaticAdminApiKey = false;

vi.mock('../../src/middleware/auth.js', () => ({
  requireGlobalAdmin: [
    (req: any, res: any, next: () => void) => {
      if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
      req.user = currentUser;
      if (isStaticAdminApiKey) req.isStaticAdminApiKey = true;
      next();
    },
    (req: any, res: any, next: () => void) => {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      next();
    },
  ],
}));

vi.mock('../../src/utils/html-config.js', () => ({
  serveHtmlWithConfig: mocks.serveHtml,
}));

vi.mock('../../src/db/brand-db.js', () => ({
  BrandDatabase: class {
    getDiscoveredBrandByDomain = mocks.getBrand;
    approveBrand = mocks.approveBrand;
    deleteDiscoveredBrand = mocks.deleteBrand;
    rollbackBrand = mocks.rollbackBrand;
  },
}));

vi.mock('../../src/db/property-db.js', () => ({
  PropertyDatabase: class {
    getHostedPropertyByDomain = mocks.getProperty;
    approveProperty = mocks.approveProperty;
    deleteHostedPropertyByDomain = mocks.deleteProperty;
    rollbackProperty = mocks.rollbackProperty;
  },
}));

vi.mock('../../src/db/registry-review-queue-db.js', () => ({
  listRegistryReviewQueue: mocks.listQueue,
  getRegistryReviewBacklog: mocks.getBacklog,
  getOpenRegistryReviewItem: mocks.getOpenItem,
  resolveRegistryReviewItem: mocks.resolveItem,
  reopenRegistryReviewItem: mocks.reopenItem,
  resolveOpenRegistryReviewItemsForRecord: mocks.resolveForRecord,
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyRegistryReviewResolved: mocks.notifyResolved,
}));

import { setupRegistryReviewRoutes } from '../../src/routes/admin/registry-review.js';

const ITEM_ID = '11111111-2222-4333-8444-555555555555';

function makeApp() {
  const app = express();
  app.use(express.json());
  const pageRouter = express.Router();
  const apiRouter = express.Router();
  setupRegistryReviewRoutes(pageRouter, apiRouter);
  app.use('/admin', pageRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

function editItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    entity_type: 'brand',
    domain: 'acme.example',
    submission_kind: 'edit',
    revision_number: 7,
    submitter_user_id: 'user_mallory',
    submitter_email: 'mallory@example.com',
    verdict: 'needs_human_review',
    reason: 'could not decide',
    created_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

describe('admin registry review routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: 'user_mod', email: 'mod@example.com', displayName: 'Mod Erator' };
    isAdmin = true;
    isStaticAdminApiKey = false;
    mocks.listQueue.mockResolvedValue([]);
    mocks.getBacklog.mockResolvedValue({
      pending_brands: 2, pending_properties: 1, pending_records: 3, flagged_edits: 1,
      total: 4, oldest_created_at: '2026-10-01T00:00:00.000Z', oldest_age_hours: 96,
      generated_at: '2026-10-05T00:00:00.000Z',
    });
    mocks.resolveForRecord.mockResolvedValue(1);
    mocks.reopenItem.mockResolvedValue(undefined);
    mocks.approveBrand.mockResolvedValue(true);
    mocks.approveProperty.mockResolvedValue(true);
    mocks.deleteBrand.mockResolvedValue(true);
    mocks.deleteProperty.mockResolvedValue(true);
    mocks.rollbackBrand.mockResolvedValue({ brand: {}, revision_number: 8 });
    mocks.rollbackProperty.mockResolvedValue({ property: {}, revision_number: 8 });
  });

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      currentUser = null;
      await request(makeApp()).get('/api/admin/registry-review/queue').expect(401);
      await request(makeApp()).get('/api/admin/registry-review/backlog').expect(401);
      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/acme.example')
        .send({ action: 'approve' })
        .expect(401);
    });

    it('refuses a non-admin member', async () => {
      isAdmin = false;
      await request(makeApp()).get('/api/admin/registry-review/queue').expect(403);
      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/acme.example')
        .send({ action: 'approve' })
        .expect(403);
      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(403);
      expect(mocks.approveBrand).not.toHaveBeenCalled();
      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
    });

    it('lets the static admin API key read the backlog but not moderate', async () => {
      isStaticAdminApiKey = true;
      currentUser = { id: 'admin_api_key', email: 'admin-api-key@internal' };

      await request(makeApp()).get('/api/admin/registry-review/backlog').expect(200);

      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/brand/acme.example')
        .send({ action: 'approve' })
        .expect(403);
      expect(res.body.error).toMatch(/Human admin session/i);
      expect(mocks.approveBrand).not.toHaveBeenCalled();
      expect(mocks.getBrand).not.toHaveBeenCalled();
    });

    it('refuses a tenant API-key session on moderation actions', async () => {
      currentUser = { id: 'api_key_tenant_1', email: 'key@tenant.example' };
      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(403);
      expect(mocks.getOpenItem).not.toHaveBeenCalled();
    });
  });

  describe('queue and backlog reads', () => {
    it('returns the queue with the backlog signal attached', async () => {
      mocks.listQueue.mockResolvedValue([{ kind: 'pending_record', domain: 'acme.example' }]);

      const res = await request(makeApp()).get('/api/admin/registry-review/queue').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.backlog).toMatchObject({ total: 4, oldest_age_hours: 96 });
    });

    it('clamps the page size', async () => {
      await request(makeApp()).get('/api/admin/registry-review/queue?limit=9999&offset=-4').expect(200);
      expect(mocks.listQueue).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    });

    it('serves the backlog count and oldest age on its own', async () => {
      const res = await request(makeApp()).get('/api/admin/registry-review/backlog').expect(200);
      expect(res.body).toMatchObject({ total: 4, pending_records: 3, flagged_edits: 1, oldest_age_hours: 96 });
    });
  });

  describe('pending record decisions', () => {
    it('approves a pending brand and records the moderator', async () => {
      mocks.getBrand.mockResolvedValue({ domain: 'acme.example', review_status: 'pending' });

      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/brand/acme.example')
        .send({ action: 'approve' })
        .expect(200);

      expect(res.body).toMatchObject({ success: true, resolution: 'approved' });
      expect(mocks.approveBrand).toHaveBeenCalledWith('acme.example');
      expect(mocks.resolveForRecord).toHaveBeenCalledWith(
        'brand', 'acme.example', 'approved',
        { user_id: 'user_mod', email: 'mod@example.com' },
        undefined,
      );
      expect(mocks.notifyResolved).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'approved', moderator_email: 'mod@example.com' }),
      );
    });

    it('approves a pending property', async () => {
      mocks.getProperty.mockResolvedValue({ publisher_domain: 'news.example', review_status: 'pending' });

      await request(makeApp())
        .post('/api/admin/registry-review/records/property/news.example')
        .send({ action: 'approve' })
        .expect(200);

      expect(mocks.approveProperty).toHaveBeenCalledWith('news.example');
    });

    it('rejects a pending brand, attributing the removal to the moderator', async () => {
      mocks.getBrand.mockResolvedValue({ domain: 'spam.example', review_status: 'pending' });

      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/spam.example')
        .send({ action: 'reject', note: 'obvious spam' })
        .expect(200);

      expect(mocks.deleteBrand).toHaveBeenCalledWith('spam.example', {
        actor_user_id: 'user_mod',
        source: 'admin_registry_review_reject',
      });
      expect(mocks.resolveForRecord).toHaveBeenCalledWith(
        'brand', 'spam.example', 'rejected', expect.anything(), 'obvious spam',
      );
    });

    it('never deletes a record that is not pending review', async () => {
      mocks.getBrand.mockResolvedValue({ domain: 'live.example', review_status: 'approved' });

      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/brand/live.example')
        .send({ action: 'reject' })
        .expect(409);

      expect(res.body.review_status).toBe('approved');
      expect(mocks.deleteBrand).not.toHaveBeenCalled();
      expect(mocks.resolveForRecord).not.toHaveBeenCalled();
    });

    it('treats a legacy null review_status as approved rather than pending', async () => {
      mocks.getBrand.mockResolvedValue({ domain: 'legacy.example', review_status: null });

      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/legacy.example')
        .send({ action: 'reject' })
        .expect(409);

      expect(mocks.deleteBrand).not.toHaveBeenCalled();
    });

    it('404s an unknown record', async () => {
      mocks.getBrand.mockResolvedValue(null);
      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/missing.example')
        .send({ action: 'approve' })
        .expect(404);
    });

    it('validates the entity type, domain and action', async () => {
      await request(makeApp())
        .post('/api/admin/registry-review/records/agent/acme.example')
        .send({ action: 'approve' })
        .expect(400);
      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/not%20a%20domain')
        .send({ action: 'approve' })
        .expect(400);
      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/acme.example')
        .send({ action: 'revert' })
        .expect(400);
      expect(mocks.getBrand).not.toHaveBeenCalled();
    });
  });

  describe('flagged edit decisions', () => {
    it('reverts to the revision the reviewer saw, ignoring any revision in the request', async () => {
      mocks.getOpenItem.mockResolvedValue(editItem({ revision_number: 7 }));
      mocks.resolveItem.mockResolvedValue(editItem({ revision_number: 7 }));

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        // A client-supplied revision must not steer the rollback: revision
        // N restores the state before edit N (adcp#8337).
        .send({ action: 'revert', to_revision: 1, revision_number: 1 })
        .expect(200);

      expect(res.body.restored_revision).toBe(7);
      expect(mocks.rollbackBrand).toHaveBeenCalledWith('acme.example', 7, expect.objectContaining({
        user_id: 'user_mod',
        email: 'mod@example.com',
      }));
      expect(mocks.resolveItem).toHaveBeenCalledWith(
        ITEM_ID, 'reverted', { user_id: 'user_mod', email: 'mod@example.com' }, undefined,
      );
      expect(mocks.reopenItem).not.toHaveBeenCalled();
    });

    it('reverts a property edit through the property rollback path', async () => {
      mocks.getOpenItem.mockResolvedValue(editItem({ entity_type: 'property', domain: 'news.example', revision_number: 2 }));
      mocks.resolveItem.mockResolvedValue(editItem({ entity_type: 'property' }));

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(200);

      expect(mocks.rollbackProperty).toHaveBeenCalledWith('news.example', 2, expect.anything());
    });

    it('keeps a flagged edit without touching the record', async () => {
      mocks.getOpenItem.mockResolvedValue(editItem());
      mocks.resolveItem.mockResolvedValue(editItem());

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'approve' })
        .expect(200);

      expect(res.body.resolution).toBe('approved');
      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
      expect(mocks.resolveItem).toHaveBeenCalledWith(ITEM_ID, 'approved', expect.anything(), undefined);
    });

    it('reopens the item when the revert itself fails', async () => {
      mocks.getOpenItem.mockResolvedValue(editItem());
      mocks.resolveItem.mockResolvedValue(editItem());
      mocks.rollbackBrand.mockRejectedValue(new Error('deadlock detected'));

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(500);

      // An item marked reverted by a revert that never happened is how
      // live vandalism gets closed as handled.
      expect(mocks.reopenItem).toHaveBeenCalledWith(ITEM_ID);
      expect(mocks.notifyResolved).not.toHaveBeenCalled();
    });

    it('loses the race when another moderator already claimed the item', async () => {
      mocks.getOpenItem.mockResolvedValue(editItem());
      mocks.resolveItem.mockResolvedValue(null);

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);

      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
    });

    it('404s an item that is missing or already resolved', async () => {
      mocks.getOpenItem.mockResolvedValue(null);
      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'approve' })
        .expect(404);
    });

    it('sends a pending-record item back to the record endpoint', async () => {
      mocks.getOpenItem.mockResolvedValue(editItem({ submission_kind: 'new_record', revision_number: null }));
      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);
      expect(mocks.resolveItem).not.toHaveBeenCalled();
    });

    it('rejects a malformed item id and an unknown action', async () => {
      await request(makeApp())
        .post('/api/admin/registry-review/items/not-a-uuid')
        .send({ action: 'approve' })
        .expect(400);
      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'reject' })
        .expect(400);
      expect(mocks.getOpenItem).not.toHaveBeenCalled();
    });
  });
});
