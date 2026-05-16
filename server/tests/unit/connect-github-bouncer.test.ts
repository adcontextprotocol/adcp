import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockResolveConnectUrl } = vi.hoisted(() => ({ mockResolveConnectUrl: vi.fn() }));

vi.mock('../../src/services/pipes.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/pipes.js')>(
    '../../src/services/pipes.js',
  );
  return {
    ...actual,
    resolveGitHubConnectUrl: mockResolveConnectUrl,
  };
});

const { resolveGitHubConnectUrl, buildPipesReturnTo } = await import('../../src/services/pipes.js');

/**
 * Mounts the same bouncer logic that lives in http.ts on a tiny app so we can
 * exercise the redirect/502 wiring without booting the full server. The
 * production route uses the same `buildPipesReturnTo` + `resolveGitHubConnectUrl`
 * pair, so this stays in lock-step as long as those two stay the integration
 * surface for the bouncer.
 */
function buildBouncerApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: 'user_test' };
    next();
  });
  app.get('/connect/github', async (req, res) => {
    try {
      const returnTo = buildPipesReturnTo(req.get('host') || '', req.protocol, req.query.return_to);
      const result = await resolveGitHubConnectUrl(
        (req as unknown as { user: { id: string } }).user.id,
        returnTo,
      );
      return res.redirect(302, result.url);
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
    mockResolveConnectUrl.mockReset();
  });

  it('302-redirects to a freshly minted Pipes URL on the click', async () => {
    mockResolveConnectUrl.mockResolvedValueOnce({
      status: 'authorize',
      url: 'https://auth.example/data-integrations/abc/authorize-redirect',
    });

    const res = await request(buildBouncerApp())
      .get('/connect/github')
      .query({ return_to: '/member-hub?connected=github' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://auth.example/data-integrations/abc/authorize-redirect');
    expect(mockResolveConnectUrl).toHaveBeenCalledWith('user_test', expect.stringContaining('/member-hub?connected=github'));
  });

  it('302-redirects to returnTo when the user is already connected', async () => {
    mockResolveConnectUrl.mockResolvedValueOnce({
      status: 'already_connected',
      url: 'https://example.com/member-hub?connected=github',
    });

    const res = await request(buildBouncerApp())
      .get('/connect/github')
      .query({ return_to: '/member-hub?connected=github' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/member-hub?connected=github');
  });

  it('returns 502 with a user-friendly body when WorkOS Pipes is unavailable', async () => {
    mockResolveConnectUrl.mockRejectedValueOnce(new Error('workos pipes 503'));

    const res = await request(buildBouncerApp()).get('/connect/github');

    expect(res.status).toBe(502);
    expect(res.text).toContain('Could not start GitHub connection');
    expect(res.text).toContain('/member-hub');
  });

  it('falls back to the default return_to path when the caller supplies an unsafe one', async () => {
    mockResolveConnectUrl.mockResolvedValueOnce({ status: 'authorize', url: 'https://auth.example/x' });

    await request(buildBouncerApp())
      .get('/connect/github')
      .query({ return_to: '//evil.example/owned' });

    const [, returnTo] = mockResolveConnectUrl.mock.calls[0];
    expect(returnTo).toContain('/member-hub?connected=github');
    expect(returnTo).not.toContain('evil.example');
  });
});
