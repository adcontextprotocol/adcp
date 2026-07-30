import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  countMonthlyGenerations: vi.fn(),
  createPortrait: vi.fn(),
  generatePortrait: vi.fn(),
  getPortraitData: vi.fn(),
  approvePortrait: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    const userId = req.get('x-test-user-id');
    if (userId) {
      req.user = { id: userId, email: `${userId}@example.test` };
    }
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_attacker', email: 'attacker@example.test' };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireGlobalAdmin: [],
  isDevModeEnabled: () => false,
  DEV_USERS: {},
}));

vi.mock('../../src/db/client.js', () => ({
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock('../../src/db/portrait-db.js', () => ({
  countMonthlyGenerations: (...args: unknown[]) => mocks.countMonthlyGenerations(...args),
  getActivePortrait: vi.fn(),
  getLatestGenerated: vi.fn(),
  getPortraitData: (...args: unknown[]) => mocks.getPortraitData(...args),
  getPublicBuilders: vi.fn(),
  createPortrait: (...args: unknown[]) => mocks.createPortrait(...args),
  approvePortrait: (...args: unknown[]) => mocks.approvePortrait(...args),
  removeFromUser: vi.fn(),
}));

vi.mock('../../src/services/portrait-generator.js', () => ({
  VIBE_OPTIONS: { casual: {} },
  generatePortrait: (...args: unknown[]) => mocks.generatePortrait(...args),
}));

import { createPortraitRouter, createPublicPortraitRouter } from '../../src/routes/portraits.js';

const GENERATED_PORTRAIT_ID = '11111111-1111-4111-8111-111111111111';
const APPROVED_PORTRAIT_ID = '22222222-2222-4222-8222-222222222222';

describe('portrait image object authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    const app = express();
    app.use('/api/portraits', createPublicPortraitRouter());
    return app;
  }

  it('denies an anonymous caller access to a generated preview', async () => {
    mocks.getPortraitData.mockResolvedValue({
      portrait_data: Buffer.from('private generated portrait'),
      image_url: `/api/portraits/${GENERATED_PORTRAIT_ID}.png`,
      status: 'generated',
      user_id: 'user_owner',
    });

    const response = await request(createApp())
      .get(`/api/portraits/${GENERATED_PORTRAIT_ID}.png`);

    expect(response.status).toBe(404);
    expect(response.text).toBe('Portrait not found');
  });

  it('denies another authenticated user access to a generated preview', async () => {
    mocks.getPortraitData.mockResolvedValue({
      portrait_data: Buffer.from('private generated portrait'),
      image_url: `/api/portraits/${GENERATED_PORTRAIT_ID}.png`,
      status: 'generated',
      user_id: 'user_owner',
    });

    const response = await request(createApp())
      .get(`/api/portraits/${GENERATED_PORTRAIT_ID}.png`)
      .set('x-test-user-id', 'user_other');

    expect(response.status).toBe(404);
    expect(response.text).toBe('Portrait not found');
  });

  it('allows the authenticated owner to view a generated preview', async () => {
    const image = Buffer.from('private generated portrait');
    mocks.getPortraitData.mockResolvedValue({
      portrait_data: image,
      image_url: `/api/portraits/${GENERATED_PORTRAIT_ID}.png`,
      status: 'generated',
      user_id: 'user_owner',
    });

    const response = await request(createApp())
      .get(`/api/portraits/${GENERATED_PORTRAIT_ID}.png`)
      .set('x-test-user-id', 'user_owner');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual(image);
  });

  it('allows anonymous public access to an approved portrait', async () => {
    const image = Buffer.from('approved portrait');
    mocks.getPortraitData.mockResolvedValue({
      portrait_data: image,
      image_url: `/api/portraits/${APPROVED_PORTRAIT_ID}.png`,
      status: 'approved',
      user_id: 'user_owner',
    });

    const response = await request(createApp())
      .get(`/api/portraits/${APPROVED_PORTRAIT_ID}.png`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.body).toEqual(image);
  });
});

describe('portrait membership object authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_attacker_free' }],
    });
    mocks.countMonthlyGenerations.mockResolvedValue(0);
    mocks.createPortrait.mockResolvedValue({ id: 'portrait_generated' });
    mocks.generatePortrait.mockResolvedValue({
      imageBuffer: Buffer.from('generated portrait'),
      promptUsed: 'test prompt',
    });
  });

  it('denies generation when the requested paid organization is not one of the caller memberships', async () => {
    const hasActiveSubscription = vi.fn(async (orgId: string) => orgId === 'org_victim_paid');
    const getProfileByOrgId = vi.fn().mockResolvedValue(null);
    const app = express();
    app.use(express.json());
    app.use('/portraits', createPortraitRouter({
      orgDb: { hasActiveSubscription } as any,
      memberDb: { getProfileByOrgId } as any,
      invalidateMemberContextCache: vi.fn(),
    }));

    const response = await request(app)
      .post('/portraits/generate?org=org_victim_paid')
      .send({ vibe: 'casual' });

    expect(response.status).toBe(402);
    expect(response.body.error).toBe('Active subscription required for portrait generation');
    expect(hasActiveSubscription).not.toHaveBeenCalledWith('org_victim_paid');
    expect(getProfileByOrgId).not.toHaveBeenCalledWith('org_victim_paid');
    expect(mocks.countMonthlyGenerations).not.toHaveBeenCalled();
    expect(mocks.generatePortrait).not.toHaveBeenCalled();
  });

  it('preserves portrait eligibility for a paid organization the caller belongs to', async () => {
    mocks.query.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_attacker_paid' }],
    });
    const hasActiveSubscription = vi.fn(async (orgId: string) => orgId === 'org_attacker_paid');
    const getProfileByOrgId = vi.fn().mockResolvedValue(null);
    const app = express();
    app.use('/portraits', createPortraitRouter({
      orgDb: { hasActiveSubscription } as any,
      memberDb: { getProfileByOrgId } as any,
      invalidateMemberContextCache: vi.fn(),
    }));

    const response = await request(app)
      .get('/portraits?org=org_attacker_paid');

    expect(response.status).toBe(200);
    expect(response.body.canGenerate).toBe(true);
    expect(hasActiveSubscription).toHaveBeenCalledWith('org_attacker_paid');
    expect(hasActiveSubscription).not.toHaveBeenCalledWith('org_victim_paid');
  });

  it('allows generation for a paid organization the caller belongs to', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM organization_memberships')) {
        return { rows: [{ workos_organization_id: 'org_attacker_paid' }] };
      }
      if (sql.includes('UPDATE member_portraits')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const hasActiveSubscription = vi.fn(async (orgId: string) => orgId === 'org_attacker_paid');
    const app = express();
    app.use('/portraits', createPortraitRouter({
      orgDb: { hasActiveSubscription } as any,
      memberDb: { getProfileByOrgId: vi.fn() } as any,
      invalidateMemberContextCache: vi.fn(),
    }));

    const response = await request(app)
      .post('/portraits/generate?org=org_attacker_paid')
      .field('vibe', 'casual');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'portrait_generated',
      image_url: '/api/portraits/portrait_generated.png',
      status: 'generated',
      vibe: 'casual',
    });
    expect(hasActiveSubscription).toHaveBeenCalledWith('org_attacker_paid');
    expect(mocks.countMonthlyGenerations).toHaveBeenCalledWith('user_attacker');
    expect(mocks.generatePortrait).toHaveBeenCalledOnce();
    expect(mocks.createPortrait).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user_attacker',
      status: 'generated',
    }));
  });
});

describe('portrait approval object authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApp(invalidateMemberContextCache = vi.fn()) {
    const app = express();
    app.use(express.json());
    app.use('/portraits', createPortraitRouter({
      orgDb: {} as any,
      memberDb: {} as any,
      invalidateMemberContextCache,
    }));
    return { app, invalidateMemberContextCache };
  }

  it('reports a rejected or otherwise ineligible portrait as not found without relinking it', async () => {
    mocks.approvePortrait.mockResolvedValue(null);
    const { app, invalidateMemberContextCache } = createApp();

    const response = await request(app)
      .post('/portraits/approve')
      .send({ portraitId: GENERATED_PORTRAIT_ID });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Portrait not found' });
    expect(mocks.approvePortrait).toHaveBeenCalledWith(GENERATED_PORTRAIT_ID, 'user_attacker');
    expect(invalidateMemberContextCache).not.toHaveBeenCalled();
  });

  it('still approves a generated portrait owned by the caller', async () => {
    const portrait = {
      id: GENERATED_PORTRAIT_ID,
      user_id: 'user_attacker',
      status: 'approved',
    };
    mocks.approvePortrait.mockResolvedValue(portrait);
    const { app, invalidateMemberContextCache } = createApp();

    const response = await request(app)
      .post('/portraits/approve')
      .send({ portraitId: GENERATED_PORTRAIT_ID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ portrait });
    expect(mocks.approvePortrait).toHaveBeenCalledWith(GENERATED_PORTRAIT_ID, 'user_attacker');
    expect(invalidateMemberContextCache).toHaveBeenCalledOnce();
  });
});
