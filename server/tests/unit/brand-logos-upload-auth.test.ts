/**
 * Unit tests for write-authority gate on POST /api/brands/:domain/logos.
 *
 * Brian's rule (Slack 2026-05-18): "if anybody has verified fandom.com only
 * that company can change the logo." Pia's complementary read: when no owner
 * exists, community uploads stay allowed but queue for moderation rather than
 * landing instantly. PR #3393 had auto-approved community uploads — this
 * test pins the walk-back.
 *
 * Auth matrix:
 *   verified owner exists, caller IS member of owning org → 201 + approved
 *   verified owner exists, caller NOT member             → 403 verified_owner_required
 *   no verified owner, caller is community member         → 201 + pending
 *   no verified owner, caller is registry moderator      → 201 + pending (gate is owner, not reviewer)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  isVerifiedOwner: vi.fn(),
  insertLogo: vi.fn(),
  countLogos: vi.fn().mockResolvedValue(0),
  listLogos: vi.fn().mockResolvedValue([]),
  rebuildManifestLogos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/brand-logo-auth.js', () => ({
  isVerifiedBrandOwner: (...args: unknown[]) => mocks.isVerifiedOwner(...args),
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
    insertBrandLogo = mocks.insertLogo;
    listBrandLogos = mocks.listLogos;
  },
}));

vi.mock('../../src/services/brand-logo-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brand-logo-service.js')>(
    '../../src/services/brand-logo-service.js',
  );
  return {
    ...actual,
    rebuildManifestLogos: mocks.rebuildManifestLogos,
  };
});

import { createBrandLogoRouter } from '../../src/routes/brand-logos.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';
import type { BansDatabase } from '../../src/db/bans-db.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Minimum-viable PNG: 8-byte signature + IHDR (1×1) + IDAT + IEND. Enough for
// detectContentType (magic-bytes) and extractDimensions to read width/height.
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c63000100000005000100' +
    '5d8a8f9d0000000049454e44ae426082',
  'hex',
);

function makeApp(opts: {
  hostedBrand?: { workos_organization_id?: string; domain_verified?: boolean } | null;
  isOwner: boolean;
} = { isOwner: false }) {
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
  app.use('/api', createBrandLogoRouter({ brandDb, bansDb }));
  return { app, brandDb };
}

describe('POST /api/brands/:domain/logos write authority', () => {
  beforeEach(() => {
    mocks.insertLogo.mockReset();
    mocks.insertLogo.mockImplementation(async (input) => ({
      id: 'logo_test_id',
      ...input,
    }));
  });

  it('returns 403 when a verified owner exists and the caller is not in that org', async () => {
    const { app } = makeApp({
      hostedBrand: { workos_organization_id: 'org_owner', domain_verified: true },
      isOwner: false,
    });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('verified_owner_required');
    expect(mocks.insertLogo).not.toHaveBeenCalled();
  });

  it('auto-approves uploads from a verified owner', async () => {
    const { app } = makeApp({
      hostedBrand: { workos_organization_id: 'org_owner', domain_verified: true },
      isOwner: true,
    });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.review_status).toBe('approved');
    expect(mocks.insertLogo).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'brand_owner', review_status: 'approved' }),
    );
  });

  it('queues community uploads as pending when no verified owner exists', async () => {
    const { app } = makeApp({ hostedBrand: null, isOwner: false });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.review_status).toBe('pending');
    expect(mocks.insertLogo).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'community', review_status: 'pending' }),
    );
  });

  it('queues community uploads as pending when the brand exists but is not domain-verified', async () => {
    const { app } = makeApp({
      hostedBrand: { workos_organization_id: 'org_someone', domain_verified: false },
      isOwner: false,
    });
    const res = await request(app)
      .post('/api/brands/example.com/logos')
      .field('tags', 'primary')
      .attach('file', MINIMAL_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.review_status).toBe('pending');
  });
});
