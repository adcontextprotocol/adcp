import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'user@example.com' };
    next();
  },
}));

import { createCommunityRouters } from '../../src/routes/community.js';

describe('community profile URL write boundary', () => {
  it('rejects a credential-bearing directory website before either profile is written', async () => {
    const communityDb = {
      getProfile: vi.fn(),
      updateProfile: vi.fn(),
    } as any;
    const memberDb = {
      getProfileByOrgId: vi.fn(),
      updateProfileByOrgId: vi.fn(),
      createProfile: vi.fn(),
    } as any;
    const orgDb = {
      getOrganization: vi.fn(),
      hasActiveSubscription: vi.fn(),
    } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/me', createCommunityRouters({ communityDb, memberDb, orgDb }).userRouter);

    const response = await request(app)
      .put('/api/me/community-profile')
      .send({
        headline: 'Updated headline',
        contact_website: 'https://user:password@example.com/',
      })
      .expect(400);

    expect(response.body.error).toBe('Profile URLs must be valid HTTP or HTTPS URLs');
    expect(response.body.error).not.toContain('credentials');
    expect(communityDb.updateProfile).not.toHaveBeenCalled();
    expect(memberDb.updateProfileByOrgId).not.toHaveBeenCalled();
    expect(memberDb.createProfile).not.toHaveBeenCalled();
  });
});
