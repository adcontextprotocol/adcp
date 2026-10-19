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
  claimItem: vi.fn(),
  releaseClaim: vi.fn(),
  rollbackLandedAfter: vi.fn(),
  getModerationState: vi.fn(),
  listOpenEdits: vi.fn(),
  resolveEditsForRecord: vi.fn(),
  resolveReverted: vi.fn(),
  resolveForRecord: vi.fn(),
  approveBrand: vi.fn(),
  deleteBrand: vi.fn(),
  rollbackBrand: vi.fn(),
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
    approveBrand = mocks.approveBrand;
    deleteDiscoveredBrand = mocks.deleteBrand;
    rollbackBrand = mocks.rollbackBrand;
  },
}));

vi.mock('../../src/db/property-db.js', () => ({
  PropertyDatabase: class {
    approveProperty = mocks.approveProperty;
    deleteHostedPropertyByDomain = mocks.deleteProperty;
    rollbackProperty = mocks.rollbackProperty;
  },
}));

vi.mock('../../src/db/registry-review-queue-db.js', () => ({
  listRegistryReviewQueue: mocks.listQueue,
  getRegistryReviewBacklog: mocks.getBacklog,
  claimRegistryReviewItem: mocks.claimItem,
  releaseRegistryReviewItemClaim: mocks.releaseClaim,
  rollbackLandedAfter: mocks.rollbackLandedAfter,
  getRegistryRecordModerationState: mocks.getModerationState,
  listOpenRegistryEditItemsForRecord: mocks.listOpenEdits,
  resolveOpenRegistryEditItemsForRecord: mocks.resolveEditsForRecord,
  resolveRevertedRegistryEditItems: mocks.resolveReverted,
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
    mocks.getModerationState.mockResolvedValue({ exists: true, review_status: 'pending', has_submitter: true });
    mocks.approveBrand.mockResolvedValue(true);
    mocks.approveProperty.mockResolvedValue(true);
    mocks.deleteBrand.mockResolvedValue(true);
    mocks.deleteProperty.mockResolvedValue(true);
    mocks.rollbackBrand.mockResolvedValue({ brand: {}, revision_number: 8 });
    mocks.rollbackProperty.mockResolvedValue({ property: {}, revision_number: 8 });
    mocks.listOpenEdits.mockResolvedValue([]);
    mocks.releaseClaim.mockResolvedValue(undefined);
    mocks.rollbackLandedAfter.mockResolvedValue(false);
    mocks.resolveEditsForRecord.mockResolvedValue(1);
    mocks.resolveReverted.mockResolvedValue(1);
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
      expect(mocks.getModerationState).not.toHaveBeenCalled();
    });

    it('refuses a tenant API-key session on moderation actions', async () => {
      currentUser = { id: 'api_key_tenant_1', email: 'key@tenant.example' };
      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(403);
      expect(mocks.claimItem).not.toHaveBeenCalled();
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
      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/brand/acme.example')
        .send({ action: 'approve' })
        .expect(200);

      expect(res.body).toMatchObject({ success: true, resolution: 'approved' });
      // The pending predicate repeats inside the write, so a review
      // that finishes between the read and the write cannot turn this
      // into a decision about a live record.
      expect(mocks.approveBrand).toHaveBeenCalledWith('acme.example', { onlyIfPending: true });
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
      await request(makeApp())
        .post('/api/admin/registry-review/records/property/news.example')
        .send({ action: 'approve' })
        .expect(200);

      expect(mocks.approveProperty).toHaveBeenCalledWith('news.example', { onlyIfPending: true });
    });

    it('rejects a pending brand, attributing the removal to the moderator', async () => {
      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/spam.example')
        .send({ action: 'reject', note: 'obvious spam' })
        .expect(200);

      expect(mocks.deleteBrand).toHaveBeenCalledWith(
        'spam.example',
        { actor_user_id: 'user_mod', source: 'admin_registry_review_reject' },
        { onlyIfPending: true },
      );
      expect(mocks.resolveForRecord).toHaveBeenCalledWith(
        'brand', 'spam.example', 'rejected', expect.anything(), 'obvious spam',
      );
    });

    it('never deletes a record that is not pending review', async () => {
      mocks.getModerationState.mockResolvedValue({ exists: true, review_status: 'approved', has_submitter: true });

      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/brand/live.example')
        .send({ action: 'reject' })
        .expect(409);

      expect(res.body.review_status).toBe('approved');
      expect(mocks.deleteBrand).not.toHaveBeenCalled();
      expect(mocks.resolveForRecord).not.toHaveBeenCalled();
    });

    it('treats a legacy null review_status as approved rather than pending', async () => {
      mocks.getModerationState.mockResolvedValue({ exists: true, review_status: null, has_submitter: true });

      await request(makeApp())
        .post('/api/admin/registry-review/records/brand/legacy.example')
        .send({ action: 'reject' })
        .expect(409);

      expect(mocks.deleteBrand).not.toHaveBeenCalled();
    });

    it('refuses when the record stopped being pending between the read and the write', async () => {
      // The review this queue exists for can finish at any moment. The
      // read says pending; the conditional write is the boundary.
      mocks.deleteBrand.mockResolvedValue(false);

      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/brand/raced.example')
        .send({ action: 'reject' })
        .expect(409);

      expect(res.body.error).toMatch(/no longer pending/i);
      expect(mocks.resolveForRecord).not.toHaveBeenCalled();
      expect(mocks.notifyResolved).not.toHaveBeenCalled();
    });

    it('404s an unknown record', async () => {
      mocks.getModerationState.mockResolvedValue({ exists: false, review_status: null, has_submitter: false });
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
      expect(mocks.getModerationState).not.toHaveBeenCalled();
    });

    it('refuses to act on a pending row that has no community submitter', async () => {
      // `issueDomainClaim` parks a bare hosted_properties row at
      // review_status = 'pending' while a publisher proves origin control.
      // Approving it would publish an empty document as the publisher's
      // own; rejecting it would strand the claim token.
      mocks.getModerationState.mockResolvedValue({
        exists: true, review_status: 'pending', has_submitter: false,
      });

      const res = await request(makeApp())
        .post('/api/admin/registry-review/records/property/claiming.example')
        .send({ action: 'reject' })
        .expect(409);

      expect(res.body.error).toMatch(/not a community submission/i);
      expect(mocks.deleteProperty).not.toHaveBeenCalled();
      expect(mocks.approveProperty).not.toHaveBeenCalled();
    });
  });

  describe('flagged edit decisions', () => {
    it('reverts to the revision the reviewer saw, ignoring any revision in the request', async () => {
      const item = editItem({ revision_number: 7 });
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);
      mocks.rollbackBrand.mockResolvedValue({ brand: {}, revision_number: 9 });

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        // A client-supplied revision must not steer the rollback: revision
        // N restores the state before edit N (adcp#8337).
        .send({ action: 'revert', to_revision: 1, revision_number: 1 })
        .expect(200);

      expect(res.body.restored_revision).toBe(7);
      expect(mocks.rollbackBrand).toHaveBeenCalledWith(
        'acme.example',
        7,
        expect.objectContaining({ user_id: 'user_mod', email: 'mod@example.com' }),
        // The pre-check is the friendly error; the in-transaction guard
        // is the boundary two moderators actually race on.
        { onlyIfNoRollbackSince: true },
      );
      // Items are closed by the revision the rollback created, not by
      // the list read before it, so an edit that lands mid-flight is
      // covered rather than left with a poisoned revert target.
      expect(mocks.resolveReverted).toHaveBeenCalledWith(
        'brand', 'acme.example', 9, { user_id: 'user_mod', email: 'mod@example.com' }, undefined,
      );
      expect(mocks.releaseClaim).not.toHaveBeenCalled();
    });

    it('reverts stacked edits to the earliest open revision', async () => {
      // An inconclusive verdict bans nobody, so the same member can
      // stack edits 5, 6 and 7. Restoring revision 5 undoes all three;
      // "reverting" item 7 on its own would put 5 and 6 back.
      const fifth = { ...editItem({ revision_number: 5 }), id: 'item-5' };
      const sixth = { ...editItem({ revision_number: 6 }), id: 'item-6' };
      const seventh = editItem({ revision_number: 7 });
      mocks.claimItem.mockResolvedValue(seventh);
      mocks.listOpenEdits.mockResolvedValue([fifth, sixth, seventh]);
      mocks.rollbackBrand.mockResolvedValue({ brand: {}, revision_number: 10 });
      mocks.resolveReverted.mockResolvedValue(3);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(200);

      expect(mocks.rollbackBrand).toHaveBeenCalledWith(
        'acme.example', 5, expect.anything(), { onlyIfNoRollbackSince: true },
      );
      expect(res.body.restored_revision).toBe(5);
      expect(res.body.resolved_items).toBe(3);
      expect(mocks.notifyResolved).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'edit',
        action: 'reverted',
        restored_revision: 5,
        reverted_edits: 3,
      }));
    });

    it('skips edits with no revision when picking the rollback target', async () => {
      const unknown = { ...editItem({ revision_number: null }), id: 'item-unknown' };
      const fourth = { ...editItem({ revision_number: 4 }), id: 'item-4' };
      mocks.claimItem.mockResolvedValue(fourth);
      mocks.listOpenEdits.mockResolvedValue([fourth, unknown]);

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(200);

      expect(mocks.rollbackBrand).toHaveBeenCalledWith(
        'acme.example', 4, expect.anything(), { onlyIfNoRollbackSince: true },
      );
    });

    it('reverts a property edit through the property rollback path', async () => {
      const item = editItem({ entity_type: 'property', domain: 'news.example', revision_number: 2 });
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(200);

      expect(mocks.rollbackProperty).toHaveBeenCalledWith(
        'news.example', 2, expect.anything(), { onlyIfNoRollbackSince: true },
      );
    });

    it('keeps every flagged edit on the record without touching it', async () => {
      mocks.claimItem.mockResolvedValue(editItem());
      mocks.listOpenEdits.mockResolvedValue([editItem({ revision_number: 7 })]);
      mocks.resolveEditsForRecord.mockResolvedValue(2);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'approve' })
        .expect(200);

      expect(res.body.resolution).toBe('approved');
      expect(res.body.resolved_items).toBe(2);
      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
      expect(mocks.resolveEditsForRecord).toHaveBeenCalledWith(
        'brand', 'acme.example', 'approved', expect.anything(), undefined,
      );
      expect(mocks.notifyResolved).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'edit', action: 'approved' }),
      );
    });

    it('records vandalism it could not undo as dismissed, not approved', async () => {
      // "Approved" would put the moderator's name behind content they
      // only failed to roll back.
      mocks.claimItem.mockResolvedValue(editItem({ revision_number: null }));
      mocks.listOpenEdits.mockResolvedValue([editItem({ revision_number: null })]);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'approve', note: 'nothing to roll back to' })
        .expect(200);

      expect(res.body.resolution).toBe('dismissed');
      expect(mocks.resolveEditsForRecord).toHaveBeenCalledWith(
        'brand', 'acme.example', 'dismissed', expect.anything(), 'nothing to roll back to',
      );
    });

    it('refuses a revert target the record was already rolled back past', async () => {
      // The review is asynchronous, so an item can name a revision
      // whose snapshot is the pre-revert state. Restoring it would put
      // back exactly what the first revert removed.
      const item = editItem({ revision_number: 5 });
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);
      mocks.rollbackLandedAfter.mockResolvedValue(true);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);

      expect(res.body.error).toMatch(/already rolled back/i);
      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
      expect(mocks.releaseClaim).toHaveBeenCalledWith(ITEM_ID);
    });

    it('refuses to keep edits another moderator is acting on', async () => {
      mocks.claimItem.mockResolvedValue(editItem());
      mocks.listOpenEdits.mockResolvedValue([editItem({ revision_number: 7 })]);
      // The all-or-nothing UPDATE closed nothing: somebody holds one.
      mocks.resolveEditsForRecord.mockResolvedValue(0);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'approve' })
        .expect(409);

      expect(res.body.message).toMatch(/another moderator/i);
      expect(mocks.notifyResolved).not.toHaveBeenCalled();
      expect(mocks.releaseClaim).toHaveBeenCalledWith(ITEM_ID);
    });

    it('reports a lost race as a conflict rather than a server error', async () => {
      // Two moderators can both clear the pre-check; only one holds
      // the row lock, and the in-transaction guard stops the loser
      // from restoring a revision above the winner's rollback.
      const item = editItem();
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);
      mocks.rollbackBrand.mockRejectedValue(new Error('Cannot roll back brand past a later rollback'));

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);

      expect(res.body.error).toMatch(/already rolled back/i);
      expect(mocks.resolveReverted).not.toHaveBeenCalled();
      expect(mocks.releaseClaim).toHaveBeenCalledWith(ITEM_ID);
    });

    it('records a keep as dismissed when the record was already rolled back past the edits', async () => {
      // The revert path refuses this item, so "keep" is the only way
      // to clear it — and it is not an approval of the content.
      mocks.claimItem.mockResolvedValue(editItem({ revision_number: 5 }));
      mocks.listOpenEdits.mockResolvedValue([editItem({ revision_number: 5 })]);
      mocks.rollbackLandedAfter.mockResolvedValue(true);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'approve' })
        .expect(200);

      expect(res.body.resolution).toBe('dismissed');
    });

    it('releases the claim and resolves nothing when the revert fails', async () => {
      const item = editItem();
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);
      mocks.rollbackBrand.mockRejectedValue(new Error('deadlock detected'));

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(500);

      // Claiming is not resolving: an item marked reverted by a revert
      // that never happened is how live vandalism gets closed as handled.
      expect(mocks.resolveReverted).not.toHaveBeenCalled();
      expect(mocks.releaseClaim).toHaveBeenCalledWith(ITEM_ID);
      expect(mocks.notifyResolved).not.toHaveBeenCalled();
    });

    it('still reports success when the rollback landed but the queue write failed', async () => {
      const item = editItem();
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);
      mocks.resolveReverted.mockRejectedValue(new Error('connection terminated'));

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(200);

      // The record really was rolled back; reporting a failure would
      // invite a moderator to do it again.
      expect(res.body.resolution).toBe('reverted');
      expect(mocks.rollbackBrand).toHaveBeenCalled();
    });

    it('refuses when another moderator holds the claim', async () => {
      mocks.claimItem.mockResolvedValue(null);

      const res = await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);

      expect(res.body.error).toMatch(/not available/i);
      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
    });

    it('refuses to revert an edit with no recorded revision, and releases the claim', async () => {
      const item = editItem({ revision_number: null });
      mocks.claimItem.mockResolvedValue(item);
      mocks.listOpenEdits.mockResolvedValue([item]);

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);

      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
      expect(mocks.releaseClaim).toHaveBeenCalledWith(ITEM_ID);
    });

    it('sends a pending-record item back to the record endpoint and releases the claim', async () => {
      mocks.claimItem.mockResolvedValue(editItem({ submission_kind: 'new_record', revision_number: null }));

      await request(makeApp())
        .post(`/api/admin/registry-review/items/${ITEM_ID}`)
        .send({ action: 'revert' })
        .expect(409);

      expect(mocks.resolveEditsForRecord).not.toHaveBeenCalled();
      expect(mocks.resolveReverted).not.toHaveBeenCalled();
      expect(mocks.releaseClaim).toHaveBeenCalledWith(ITEM_ID);
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
      expect(mocks.claimItem).not.toHaveBeenCalled();
    });
  });
});
