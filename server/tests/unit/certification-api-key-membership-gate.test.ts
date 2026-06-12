import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
  enrichUserWithMembership: vi.fn(),
  getModule: vi.fn(),
  checkPrerequisites: vi.fn(),
  getModuleProgress: vi.fn(),
  startModule: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD =
    process.env.WORKOS_COOKIE_PASSWORD ?? 'placeholder-cookie-password-32-bytes-min';
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      apiKeys: {
        createValidation: mocks.createValidation,
      },
      userManagement: {
        listOrganizationMemberships: vi.fn(),
      },
    };
  }),
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBanForApiKey: mocks.checkPlatformBanForApiKey,
    checkPlatformBan: mocks.checkPlatformBan,
  },
}));

vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));

vi.mock('../../src/utils/html-config.js', () => ({
  enrichUserWithMembership: mocks.enrichUserWithMembership,
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getModule: mocks.getModule,
  checkPrerequisites: mocks.checkPrerequisites,
  getModuleProgress: mocks.getModuleProgress,
  startModule: mocks.startModule,
}));

import { createCertificationRouters } from '../../src/routes/certification.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  const { userRouter } = createCertificationRouters();
  app.use('/api/me', userRouter);
  return app;
}

describe('certification API-key membership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createValidation.mockResolvedValue({
      apiKey: {
        id: 'key_123',
        owner: { id: 'org_free_tier' },
        name: 'Free tier API key',
        permissions: [],
      },
    });
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false, ban: null });
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: false });
    mocks.getModule.mockResolvedValue({
      id: 'paid-module',
      track_id: 'A',
      title: 'Paid module',
      description: null,
      format: 'lesson',
      duration_minutes: 30,
      sort_order: 1,
      is_free: false,
      prerequisites: [],
      lesson_plan: { objectives: [], key_concepts: [], discussion_prompts: [] },
      exercise_definitions: [],
      assessment_criteria: null,
      tenant_ids: null,
    });
    mocks.enrichUserWithMembership.mockImplementation(async (user: { isMember?: boolean } | null | undefined) => {
      if (user && user.isMember === undefined) user.isMember = false;
      return user;
    });
    mocks.checkPrerequisites.mockResolvedValue({ met: true, missing: [] });
    mocks.getModuleProgress.mockResolvedValue(null);
    mocks.startModule.mockResolvedValue({ module_id: 'paid-module', status: 'in_progress' });
  });

  it('does not let a WorkOS API key start a paid module without resolved membership', async () => {
    const res = await request(buildApp())
      .post('/api/me/certification/modules/paid-module/start')
      .set('Authorization', 'Bearer sk_test_free_tier')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Membership required',
      message: 'This module requires an active AgenticAdvertising.org membership.',
    });
    expect(mocks.enrichUserWithMembership).toHaveBeenCalledOnce();
    expect(mocks.checkPrerequisites).not.toHaveBeenCalled();
    expect(mocks.startModule).not.toHaveBeenCalled();
  });
});
