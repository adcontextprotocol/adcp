import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockGetAuthorizeUrl } = vi.hoisted(() => ({ mockGetAuthorizeUrl: vi.fn() }));

vi.mock('../../src/services/pipes.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/pipes.js')>(
    '../../src/services/pipes.js',
  );
  return {
    ...actual,
    getGitHubAuthorizeUrl: mockGetAuthorizeUrl,
  };
});

const { getGitHubAuthorizeUrl, buildPipesReturnTo } = await import('../../src/services/pipes.js');

/**
 * Mounts the same bouncer logic that lives in http.ts on a tiny app so we can
 * exercise the redirect/502 wiring without booting the full server. The
 * production route uses the same `buildPipesReturnTo` + `getGitHubAuthorizeUrl`
 * pair, so this stays in lock-step as long as those two stay the integration
 * surface for the bouncer.
 */
function buildBouncerApp() {
  const app = express();
  // Stub requireAuth so we don't drag in the WorkOS session machinery.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: 'user_test' };
    next();
  });
  app.get('/connect/github', async (req, res) => {
    try {
      const returnTo = buildPipesReturnTo(req.get('host') || '', req.protocol, req.query.return_to);
      const url = await getGitHubAuthorizeUrl(
        (req as unknown as { user: { id: string } }).user.id,
        returnTo,
      );
      return res.redirect(302, url);
    } catch {
      return res
        .status(502)
        .send('Could not start GitHub connection. Please try again in a moment, or visit /member-hub to connect from there.');
    }
  });
  return app;
}

describe('GET /connect/github bouncer', () => {
  beforeEach(() => {
    mockGetAuthorizeUrl.mockReset();
  });

  it('302-redirects to a freshly minted Pipes URL on the click', async () => {
    mockGetAuthorizeUrl.mockResolvedValueOnce('https://auth.example/data-integrations/abc/authorize-redirect');

    const res = await request(buildBouncerApp())
      .get('/connect/github')
      .query({ return_to: '/member-hub?connected=github' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://auth.example/data-integrations/abc/authorize-redirect');
    // Pipes URL is minted on click using the verified session user, not at message-write time.
    expect(mockGetAuthorizeUrl).toHaveBeenCalledWith('user_test', expect.stringContaining('/member-hub?connected=github'));
  });

  it('returns 502 with a user-friendly body when WorkOS Pipes is unavailable', async () => {
    mockGetAuthorizeUrl.mockRejectedValueOnce(new Error('workos pipes 503'));

    const res = await request(buildBouncerApp()).get('/connect/github');

    expect(res.status).toBe(502);
    expect(res.text).toContain('Could not start GitHub connection');
    // The fallback should still point users at the Hub so they aren't dead-ended.
    expect(res.text).toContain('/member-hub');
  });

  it('falls back to the default return_to path when the caller supplies an unsafe one', async () => {
    mockGetAuthorizeUrl.mockResolvedValueOnce('https://auth.example/x');

    await request(buildBouncerApp())
      .get('/connect/github')
      .query({ return_to: '//evil.example/owned' });

    const [, returnTo] = mockGetAuthorizeUrl.mock.calls[0];
    expect(returnTo).toContain('/member-hub?connected=github');
    expect(returnTo).not.toContain('evil.example');
  });
});
