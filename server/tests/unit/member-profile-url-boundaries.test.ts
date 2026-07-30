import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolvePrimaryOrganization: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getPool: vi.fn(),
}));

vi.mock('../../src/db/users-db.js', () => ({
  resolvePrimaryOrganization: mocks.resolvePrimaryOrganization,
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: 'user-profile-url', email: 'profile-url@example.test' };
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireGlobalAdmin: [(_req: unknown, _res: unknown, next: () => void) => next()],
  refuseCrossTenantAdminApiKey: () => false,
  isDevModeEnabled: () => false,
  DEV_USERS: {},
}));

vi.mock('../../src/middleware/rate-limit.js', () => ({
  isMemberProfileBootstrapBody: () => false,
  memberProfileBootstrapRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from 'supertest';
import {
  createAdminMemberProfileRouter,
  createMemberProfileRouter,
} from '../../src/routes/member-profiles.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { CommunityDatabase } from '../../src/db/community-db.js';
import { createCommunityRouters } from '../../src/routes/community.js';

function createConfig() {
  const getProfileByOrgId = vi.fn();
  const getProfileById = vi.fn();
  return {
    config: {
      memberDb: { getProfileByOrgId, getProfileById },
      brandDb: {},
      orgDb: {},
      invalidateMemberContextCache: vi.fn(),
    } as any,
    getProfileByOrgId,
    getProfileById,
  };
}

describe('member profile URL persistence boundaries', () => {
  it('rejects unsafe URLs at the shared database boundary', async () => {
    const memberDb = new MemberDatabase();

    await expect(memberDb.createProfile({
      workos_organization_id: 'org-unsafe',
      display_name: 'Unsafe Media',
      slug: 'unsafe-media',
      linkedin_url: 'javascript:alert(1)',
    })).rejects.toThrow('linkedin_url must be an HTTPS URL without credentials');

    await expect(memberDb.updateProfile('profile-unsafe', {
      contact_website: 'https://user:secret@acme.example',
    })).rejects.toThrow('contact_website must be an HTTPS URL without credentials');

    await expect(memberDb.updateProfile('profile-unsafe', {
      twitter_url: 'http://social.example/unsafe',
    })).rejects.toThrow('twitter_url must be an HTTPS URL without credentials');

    await expect(new CommunityDatabase().updateProfile('user-unsafe', {
      twitter_url: 'javascript:alert(1)',
    })).rejects.toThrow('twitter_url must be an HTTPS URL without credentials');

    await expect(memberDb.createProfile({
      workos_organization_id: 'org-control',
      display_name: 'Control Media',
      slug: 'control-media',
      linkedin_url: 'https://social.example/acme\r\nInjected',
    })).rejects.toThrow('linkedin_url must be an HTTPS URL without credentials');

    await expect(memberDb.updateProfile('profile-control', {
      contact_website: '\thttps://acme.example',
    })).rejects.toThrow('contact_website must be an HTTPS URL without credentials');

    await expect(new CommunityDatabase().updateProfile('user-control', {
      twitter_url: 'https://social.example/acme\u007F',
    })).rejects.toThrow('twitter_url must be an HTTPS URL without credentials');
  });

  it.each([
    ['linkedin_url', 'javascript:alert(1)'],
    ['twitter_url', 'http://social.example/acme'],
    ['contact_website', 'https://user:secret@acme.example'],
  ])('rejects unsafe %s values on create', async (field, value) => {
    const { config, getProfileByOrgId } = createConfig();
    const app = express();
    app.use(express.json());
    app.use('/api/me/member-profile', createMemberProfileRouter(config));

    const response = await request(app)
      .post('/api/me/member-profile')
      .send({ display_name: 'Acme Media', slug: 'acme-media', [field]: value });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(`${field} must be an HTTPS URL without credentials`);
    expect(getProfileByOrgId).not.toHaveBeenCalled();
  });

  it.each([
    ['linkedin_url', 'data:text/html,<script>alert(1)</script>'],
    ['twitter_url', 'https://user:secret@social.example/acme'],
    ['contact_website', 'https://acme.example" onclick="alert(1)'],
  ])('rejects unsafe %s values on update', async (field, value) => {
    const { config, getProfileByOrgId } = createConfig();
    const app = express();
    app.use(express.json());
    app.use('/api/me/member-profile', createMemberProfileRouter(config));

    const response = await request(app)
      .put('/api/me/member-profile')
      .send({ [field]: value });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(`${field} must be an HTTPS URL without credentials`);
    expect(getProfileByOrgId).not.toHaveBeenCalled();
  });

  it('applies the same URL validation to the admin update boundary', async () => {
    const { config, getProfileById } = createConfig();
    const app = express();
    app.use(express.json());
    app.use('/api/admin/member-profiles', createAdminMemberProfileRouter(config));

    const response = await request(app)
      .put('/api/admin/member-profiles/profile-1')
      .send({ twitter_url: 'javascript:alert(1)' });

    expect(response.status).toBe(400);
    expect(getProfileById).not.toHaveBeenCalled();
  });

  it('applies the shared URL validation to the community profile writer', async () => {
    const updateProfile = vi.fn();
    const app = express();
    app.use(express.json());
    const { userRouter } = createCommunityRouters({
      communityDb: { updateProfile } as any,
    });
    app.use('/api/me', userRouter);

    const response = await request(app)
      .put('/api/me/community-profile')
      .send({ twitter_url: 'http://social.example/acme' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('twitter_url must be an HTTPS URL without credentials');
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('syncs non-URL fields without rewriting unsafe legacy member URLs', async () => {
    const communityProfile = {
      workos_user_id: 'user-profile-url',
      slug: 'legacy-person',
      headline: 'Updated headline',
      bio: 'Existing bio',
      avatar_url: null,
      expertise: [],
      interests: [],
      linkedin_url: 'javascript:alert(1)',
      twitter_url: 'http://social.example/legacy',
      github_username: null,
      is_public: true,
      open_to_coffee_chat: false,
      open_to_intros: false,
      city: 'New York',
    };
    const communityDb = {
      getProfile: vi.fn().mockResolvedValue(communityProfile),
      updateProfile: vi.fn().mockResolvedValue(communityProfile),
      checkAndAwardBadges: vi.fn().mockResolvedValue(undefined),
    };
    const updateProfileByOrgId = vi.fn().mockResolvedValue({});
    const memberDb = {
      getProfileByOrgId: vi.fn().mockResolvedValue({
        id: 'member-profile-1',
        workos_organization_id: 'org-personal',
        is_public: true,
        tagline: null,
        description: 'Independently customized bio',
        offerings: [],
        contact_website: 'javascript:alert(2)',
      }),
      updateProfileByOrgId,
    };
    const orgDb = {
      getOrganization: vi.fn().mockResolvedValue({ is_personal: true }),
      hasActiveSubscription: vi.fn(),
    };
    const invalidateMemberContextCache = vi.fn();
    mocks.resolvePrimaryOrganization.mockResolvedValue('org-personal');
    mocks.query.mockResolvedValue({
      rows: [{ first_name: 'Legacy', last_name: 'Person' }],
    });

    const app = express();
    app.use(express.json());
    const { userRouter } = createCommunityRouters({
      communityDb: communityDb as any,
      memberDb: memberDb as any,
      orgDb: orgDb as any,
      invalidateMemberContextCache,
    });
    app.use('/api/me', userRouter);

    const response = await request(app)
      .put('/api/me/community-profile')
      .send({ headline: 'Updated headline' });

    expect(response.status).toBe(200);
    expect(updateProfileByOrgId).toHaveBeenCalledWith('org-personal', {
      display_name: 'Legacy Person',
      tagline: 'Updated headline',
    });
    const memberUpdates = updateProfileByOrgId.mock.calls[0][1];
    expect(memberUpdates).not.toHaveProperty('linkedin_url');
    expect(memberUpdates).not.toHaveProperty('twitter_url');
    expect(memberUpdates).not.toHaveProperty('contact_website');
    expect(invalidateMemberContextCache).toHaveBeenCalledOnce();
  });
});
