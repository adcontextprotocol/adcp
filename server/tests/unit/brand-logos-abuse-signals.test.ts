/**
 * Unit tests for the three hardening wedges that close #4748:
 *
 *   A. Per-user pending-queue threshold. A community uploader who has
 *      already accumulated N pending uploads across distinct domains in
 *      the recent window gets 429'd on the next attempt. Defends against
 *      enumeration (probing which domains are verified-owned) and queue
 *      saturation. Verified owners bypass entirely.
 *
 *   B. Per-brand reserved owner slots. Community uploads (any status) cap
 *      at MAX_COMMUNITY_LOGOS_PER_BRAND so a verified owner always has
 *      slots free even if community-pending got there first.
 *
 *   C. Threaded approve/reject Slack replies. The notify ts is persisted
 *      on insert and the review path threads the verdict reply under it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  isVerifiedOwner: vi.fn(),
  canReview: vi.fn(),
  insertLogo: vi.fn(),
  countLogos: vi.fn().mockResolvedValue(0),
  countLogosBySource: vi.fn().mockResolvedValue(0),
  countPendingDomainsForUser: vi.fn().mockResolvedValue(0),
  listLogos: vi.fn().mockResolvedValue([]),
  setSlackThreadTs: vi.fn().mockResolvedValue(undefined),
  getLogoById: vi.fn().mockResolvedValue(null),
  updateReviewStatus: vi.fn(),
  rebuildManifestLogos: vi.fn().mockResolvedValue(undefined),
  notifyPendingBrandLogo: vi.fn().mockResolvedValue(null),
  notifyBrandLogoReviewed: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyPendingBrandLogo: (...args: unknown[]) => mocks.notifyPendingBrandLogo(...args),
  notifyBrandLogoReviewed: (...args: unknown[]) => mocks.notifyBrandLogoReviewed(...args),
}));

vi.mock('../../src/services/brand-logo-auth.js', () => ({
  isVerifiedBrandOwner: (...args: unknown[]) => mocks.isVerifiedOwner(...args),
  isRegistryModerator: vi.fn().mockResolvedValue(false),
  canReviewBrandLogos: (...args: unknown[]) => mocks.canReview(...args),
}));

vi.mock('../../src/utils/html-config.js', () => ({
  enrichUserWithMembership: vi.fn().mockResolvedValue({ isMember: true }),
}));

vi.mock('../../src/middleware/rate-limit.js', () => ({
  logoUploadRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: 'user_test', email: 'test@example.com', isMember: true };
    next();
  },
  optionalAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: 'user_test', email: 'test@example.com', isMember: true };
    next();
  },
}));

vi.mock('../../src/db/brand-logo-db.js', () => ({
  BrandLogoDatabase: class {
    countBrandLogos = mocks.countLogos;
    countLogosBySource = mocks.countLogosBySource;
    countPendingDomainsForUser = mocks.countPendingDomainsForUser;
    insertBrandLogo = mocks.insertLogo;
    listBrandLogos = mocks.listLogos;
    setSlackThreadTs = mocks.setSlackThreadTs;
    getBrandLogoById = mocks.getLogoById;
    updateLogoReviewStatus = mocks.updateReviewStatus;
    getPendingLogos = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../../src/services/brand-logo-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brand-logo-service.js')>(
    '../../src/services/brand-logo-service.js',
  );
  return { ...actual, rebuildManifestLogos: mocks.rebuildManifestLogos };
});

import { createBrandLogoRouter } from '../../src/routes/brand-logos.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';
import type { BansDatabase } from '../../src/db/bans-db.js';

const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c63000100000005000100' +
    '5d8a8f9d0000000049454e44ae426082',
  'hex',
);

function makeApp(opts: {
  hostedBrand?: { workos_organization_id?: string; domain_verified?: boolean } | null;
  isOwner: boolean;
}) {
  mocks.isVerifiedOwner.mockReset();
  mocks.isVerifiedOwner.mockResolvedValue(opts.isOwner);

  const brandDb = {
    getHostedBrandByDomain: vi.fn().mockResolvedValue(opts.hostedBrand ?? null),
    getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({ domain: 'example.com', source_type: 'community' }),
    createDiscoveredBrand: vi.fn().mockResolvedValue(undefined),
    editDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 1 }),
  } as unknown as BrandDatabase;

  const bansDb = {
    isUserBannedFromRegistry: vi.fn().mockResolvedValue({ banned: false }),
  } as unknown as BansDatabase;

  const app = express();
  app.use(express.json());
  app.use('/api', createBrandLogoRouter({ brandDb, bansDb }));
  return app;
}

describe('Wedge A — per-user pending-queue threshold', () => {
  beforeEach(() => {
    mocks.insertLogo.mockReset();
    mocks.countPendingDomainsForUser.mockReset();
    mocks.countLogosBySource.mockReset();
    mocks.countLogosBySource.mockResolvedValue(0);
    mocks.insertLogo.mockImplementation(async (input) => ({ id: 'logo_x', ...input }));
  });

  it('429s a community uploader who has hit the distinct-domain threshold', async () => {
    mocks.countPendingDomainsForUser.mockResolvedValue(5);
    const app = makeApp({ hostedBrand: null, isOwner: false });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('pending_queue_full');
    expect(res.body.pending_domain_count).toBe(5);
    expect(mocks.insertLogo).not.toHaveBeenCalled();
  });

  it('verified owners bypass the threshold entirely', async () => {
    mocks.countPendingDomainsForUser.mockResolvedValue(99);
    mocks.countLogos.mockResolvedValueOnce(0);
    const app = makeApp({
      hostedBrand: { workos_organization_id: 'org_owner', domain_verified: true },
      isOwner: true,
    });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(mocks.countPendingDomainsForUser).not.toHaveBeenCalled();
  });

  it('passes under the threshold (4 pending domains is still fine)', async () => {
    mocks.countPendingDomainsForUser.mockResolvedValue(4);
    const app = makeApp({ hostedBrand: null, isOwner: false });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.review_status).toBe('pending');
  });
});

describe('Wedge B — per-brand reserved owner slots', () => {
  beforeEach(() => {
    mocks.insertLogo.mockReset();
    mocks.countPendingDomainsForUser.mockReset();
    mocks.countPendingDomainsForUser.mockResolvedValue(0);
    mocks.countLogosBySource.mockReset();
    mocks.countLogos.mockReset();
    mocks.insertLogo.mockImplementation(async (input) => ({ id: 'logo_x', ...input }));
  });

  it('400s a community upload when the brand already has 5 community logos', async () => {
    mocks.countLogosBySource.mockResolvedValue(5);
    const app = makeApp({ hostedBrand: null, isOwner: false });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('community_cap_reached');
    expect(mocks.countLogosBySource).toHaveBeenCalledWith('example.com', ['community']);
    expect(mocks.insertLogo).not.toHaveBeenCalled();
  });

  it('lets a verified owner upload even when community slots are saturated', async () => {
    mocks.countLogosBySource.mockResolvedValue(5);
    mocks.countLogos.mockResolvedValue(5); // 5 community + 0 owner
    const app = makeApp({
      hostedBrand: { workos_organization_id: 'org_owner', domain_verified: true },
      isOwner: true,
    });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    // Owner path uses the overall cap, not the per-source cap.
    expect(mocks.countLogosBySource).not.toHaveBeenCalled();
  });

  it('still rejects a verified owner once the overall cap is reached', async () => {
    mocks.countLogos.mockResolvedValue(10);
    const app = makeApp({
      hostedBrand: { workos_organization_id: 'org_owner', domain_verified: true },
      isOwner: true,
    });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Maximum/);
  });
});

describe('Wedge C — threaded approve/reject Slack replies', () => {
  beforeEach(() => {
    mocks.insertLogo.mockReset();
    mocks.setSlackThreadTs.mockReset();
    mocks.notifyPendingBrandLogo.mockReset();
    mocks.notifyBrandLogoReviewed.mockReset();
    mocks.getLogoById.mockReset();
    mocks.updateReviewStatus.mockReset();
    mocks.canReview.mockReset();
    mocks.countPendingDomainsForUser.mockResolvedValue(0);
    mocks.countLogosBySource.mockResolvedValue(0);
    // Both notifiers must return a Promise so the route's
    // .then/.catch chain doesn't blow up. mockReset() clears the
    // resolved-value contract, so restore them here.
    mocks.notifyPendingBrandLogo.mockResolvedValue(null);
    mocks.notifyBrandLogoReviewed.mockResolvedValue(null);
    mocks.setSlackThreadTs.mockResolvedValue(undefined);
    mocks.insertLogo.mockImplementation(async (input) => ({ id: 'logo_x', ...input }));
  });

  it('persists the Slack ts on successful pending-notify', async () => {
    mocks.notifyPendingBrandLogo.mockResolvedValue('1779110411.874');
    const app = makeApp({ hostedBrand: null, isOwner: false });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    // Settle microtasks — the notify→setSlackThreadTs chain is fire-and-forget.
    await new Promise((r) => setImmediate(r));
    expect(mocks.setSlackThreadTs).toHaveBeenCalledWith('logo_x', '1779110411.874');
  });

  it('skips persistence when Slack returns no ts (channel unset, etc.)', async () => {
    mocks.notifyPendingBrandLogo.mockResolvedValue(null);
    const app = makeApp({ hostedBrand: null, isOwner: false });
    await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    await new Promise((r) => setImmediate(r));
    expect(mocks.setSlackThreadTs).not.toHaveBeenCalled();
  });

  it('threads the verdict reply under the stored ts on approve', async () => {
    mocks.canReview.mockResolvedValue(true);
    mocks.getLogoById.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      domain: 'example.com',
      slack_thread_ts: '1779110411.874',
      review_status: 'pending',
    });
    mocks.updateReviewStatus.mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111' });
    const app = makeApp({ hostedBrand: null, isOwner: false });
    const res = await request(app)
      .post('/api/brands/example.com/logos/11111111-1111-1111-1111-111111111111/review')
      .send({ action: 'approve' });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(mocks.notifyBrandLogoReviewed).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: '1779110411.874',
        domain: 'example.com',
        action: 'approve',
      }),
    );
  });

  it('does not call the thread-reply notifier when no ts was stored', async () => {
    mocks.canReview.mockResolvedValue(true);
    mocks.getLogoById.mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      domain: 'example.com',
      slack_thread_ts: null,
      review_status: 'pending',
    });
    mocks.updateReviewStatus.mockResolvedValue({ id: '22222222-2222-2222-2222-222222222222' });
    const app = makeApp({ hostedBrand: null, isOwner: false });
    await request(app)
      .post('/api/brands/example.com/logos/22222222-2222-2222-2222-222222222222/review')
      .send({ action: 'reject', note: 'Wrong brand' });
    await new Promise((r) => setImmediate(r));
    expect(mocks.notifyBrandLogoReviewed).not.toHaveBeenCalled();
  });
});
