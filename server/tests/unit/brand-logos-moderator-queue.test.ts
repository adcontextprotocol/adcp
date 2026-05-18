/**
 * Unit tests for the cross-brand moderator queue endpoints introduced by
 * the #4748 follow-up:
 *
 *   GET /api/brand-logos/pending           — moderator-only list
 *   GET /api/brand-logos/:id/preview       — moderator-or-owner image bytes
 *
 * The preview endpoint is the moderator escape hatch — the public CDN
 * path (/logos/brands/:domain/:id) is strictly approved-only by design,
 * so without this route moderators couldn't actually see what they're
 * approving.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  isModerator: vi.fn(),
  isOwner: vi.fn(),
  getPending: vi.fn(),
  getLogoById: vi.fn(),
  insertLogo: vi.fn(),
  countLogos: vi.fn().mockResolvedValue(0),
  countLogosBySource: vi.fn().mockResolvedValue(0),
  countPendingDomainsForUser: vi.fn().mockResolvedValue(0),
  setSlackThreadTs: vi.fn().mockResolvedValue(undefined),
  listLogos: vi.fn().mockResolvedValue([]),
  rebuildManifestLogos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/brand-logo-auth.js', () => ({
  isRegistryModerator: (...args: unknown[]) => mocks.isModerator(...args),
  isVerifiedBrandOwner: (...args: unknown[]) => mocks.isOwner(...args),
  canReviewBrandLogos: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/utils/html-config.js', () => ({
  enrichUserWithMembership: vi.fn().mockResolvedValue({ isMember: true }),
}));

vi.mock('../../src/middleware/rate-limit.js', () => ({
  logoUploadRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: currentUserId, email: `${currentUserId}@test.example`, isMember: true };
    next();
  },
  optionalAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: currentUserId, email: `${currentUserId}@test.example`, isMember: true };
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
    getPendingLogos = mocks.getPending;
    getBrandLogoById = mocks.getLogoById;
    setSlackThreadTs = mocks.setSlackThreadTs;
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

let currentUserId = 'user_test';

function makeApp() {
  const brandDb = {
    getHostedBrandByDomain: vi.fn().mockResolvedValue(null),
    getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({ domain: 'x.example', source_type: 'community' }),
    editDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 1 }),
  } as unknown as BrandDatabase;
  const bansDb = {
    isUserBannedFromRegistry: vi.fn().mockResolvedValue({ banned: false }),
  } as unknown as BansDatabase;
  const app = express();
  app.use('/api', createBrandLogoRouter({ brandDb, bansDb }));
  return app;
}

describe('GET /api/brand-logos/pending', () => {
  beforeEach(() => {
    mocks.isModerator.mockReset();
    mocks.getPending.mockReset();
    currentUserId = 'user_test';
  });

  it('403s non-moderators', async () => {
    mocks.isModerator.mockResolvedValue(false);
    const res = await request(makeApp()).get('/api/brand-logos/pending');
    expect(res.status).toBe(403);
    expect(mocks.getPending).not.toHaveBeenCalled();
  });

  it('returns the cross-brand pending list to moderators', async () => {
    mocks.isModerator.mockResolvedValue(true);
    mocks.getPending.mockResolvedValue([
      {
        id: 'logo_1',
        domain: 'scope3.com',
        brand_name: 'Scope3',
        content_type: 'image/png',
        source: 'community',
        tags: ['primary'],
        width: 64,
        height: 64,
        uploaded_by_email: 'alice@example.com',
        uploaded_by_user_id: 'user_alice',
        upload_note: 'New press kit',
        original_filename: 'scope3.png',
        created_at: new Date('2026-05-18T10:00:00Z'),
      },
    ]);
    const res = await request(makeApp()).get('/api/brand-logos/pending');
    expect(res.status).toBe(200);
    expect(res.body.logos).toHaveLength(1);
    expect(res.body.logos[0]).toMatchObject({
      id: 'logo_1',
      domain: 'scope3.com',
      brand_name: 'Scope3',
      source: 'community',
      preview_url: '/api/brand-logos/logo_1/preview',
      review_url: '/api/brands/scope3.com/logos/logo_1/review',
      brand_view_url: '/brand/view/scope3.com',
    });
  });

  it('clamps limit to a sane upper bound and rejects negative offset', async () => {
    mocks.isModerator.mockResolvedValue(true);
    mocks.getPending.mockResolvedValue([]);
    await request(makeApp()).get('/api/brand-logos/pending?limit=999&offset=-5');
    expect(mocks.getPending).toHaveBeenCalledWith(200, 0);
  });
});

describe('GET /api/brand-logos/:id/preview', () => {
  beforeEach(() => {
    mocks.isModerator.mockReset();
    mocks.isOwner.mockReset();
    mocks.getLogoById.mockReset();
  });

  it('400s on a non-uuid id', async () => {
    const res = await request(makeApp()).get('/api/brand-logos/not-a-uuid/preview');
    expect(res.status).toBe(400);
  });

  it('serves any-status image bytes to a moderator', async () => {
    mocks.isModerator.mockResolvedValue(true);
    mocks.getLogoById.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      domain: 'scope3.com',
      content_type: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      review_status: 'pending',
    });
    const res = await request(makeApp()).get('/api/brand-logos/11111111-1111-1111-1111-111111111111/preview');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['cache-control']).toContain('private');
    expect(res.body).toBeInstanceOf(Buffer);
  });

  it('falls back to owner check when caller is not a moderator', async () => {
    mocks.isModerator.mockResolvedValue(false);
    mocks.getLogoById.mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      domain: 'acme.example',
      content_type: 'image/svg+xml',
      data: Buffer.from('<svg/>'),
      review_status: 'pending',
    });
    mocks.isOwner.mockResolvedValue(true);
    const res = await request(makeApp()).get('/api/brand-logos/22222222-2222-2222-2222-222222222222/preview');
    expect(res.status).toBe(200);
    expect(mocks.isOwner).toHaveBeenCalledWith('user_test', 'acme.example', expect.any(Object));
  });

  it('403s a non-moderator who is also not the brand owner', async () => {
    mocks.isModerator.mockResolvedValue(false);
    mocks.getLogoById.mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333',
      domain: 'acme.example',
      content_type: 'image/png',
      data: Buffer.from('x'),
      review_status: 'pending',
    });
    mocks.isOwner.mockResolvedValue(false);
    const res = await request(makeApp()).get('/api/brand-logos/33333333-3333-3333-3333-333333333333/preview');
    expect(res.status).toBe(403);
  });

  it('404s when the logo does not exist', async () => {
    mocks.isModerator.mockResolvedValue(true);
    mocks.getLogoById.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/brand-logos/44444444-4444-4444-4444-444444444444/preview');
    expect(res.status).toBe(404);
  });
});
