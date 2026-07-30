import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const fetchMock = vi.fn();

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe('resolveGitHubToken', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SECRETARIAT_APP_ID', '');
    vi.stubEnv('SECRETARIAT_APP_PRIVATE_KEY', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    const { resetGitHubAppTokenCache } = await import('../../src/addie/jobs/github-app-token.js');
    resetGitHubAppTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the legacy PAT when the App is not configured', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'pat-token');
    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await expect(resolveGitHubToken()).resolves.toBe('pat-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when neither credential exists', async () => {
    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await expect(resolveGitHubToken()).resolves.toBeNull();
  });

  it('mints an installation token when the App is configured', async () => {
    vi.stubEnv('SECRETARIAT_APP_ID', '4234645');
    vi.stubEnv('SECRETARIAT_APP_PRIVATE_KEY', privateKey);
    fetchMock
      .mockResolvedValueOnce(json([{ id: 77 }])) // GET /app/installations
      .mockResolvedValueOnce(json({ token: 'ghs_minted', expires_at: futureIso(60) }, 201));

    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await expect(resolveGitHubToken()).resolves.toBe('ghs_minted');

    // Both calls authenticate with a three-segment app JWT.
    for (const call of fetchMock.mock.calls) {
      const auth = (call[1].headers as Record<string, string>).Authorization;
      expect(auth.replace('Bearer ', '').split('.')).toHaveLength(3);
    }
    expect(fetchMock.mock.calls[1][0]).toContain('/app/installations/77/access_tokens');
  });

  it('caches the installation token until near expiry', async () => {
    vi.stubEnv('SECRETARIAT_APP_ID', '4234645');
    vi.stubEnv('SECRETARIAT_APP_PRIVATE_KEY', privateKey);
    fetchMock
      .mockResolvedValueOnce(json([{ id: 77 }]))
      .mockResolvedValueOnce(json({ token: 'ghs_minted', expires_at: futureIso(60) }, 201));

    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await resolveGitHubToken();
    await expect(resolveGitHubToken()).resolves.toBe('ghs_minted');
    expect(fetchMock).toHaveBeenCalledTimes(2); // no extra calls for the second resolve
  });

  it('re-mints when the cached token is near expiry', async () => {
    vi.stubEnv('SECRETARIAT_APP_ID', '4234645');
    vi.stubEnv('SECRETARIAT_APP_PRIVATE_KEY', privateKey);
    fetchMock
      .mockResolvedValueOnce(json([{ id: 77 }]))
      .mockResolvedValueOnce(json({ token: 'ghs_old', expires_at: futureIso(2) }, 201))
      .mockResolvedValueOnce(json({ token: 'ghs_new', expires_at: futureIso(60) }, 201));

    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await expect(resolveGitHubToken()).resolves.toBe('ghs_old');
    await expect(resolveGitHubToken()).resolves.toBe('ghs_new');
  });

  it('fails closed (null, not PAT) when the configured App cannot mint', async () => {
    vi.stubEnv('SECRETARIAT_APP_ID', '4234645');
    vi.stubEnv('SECRETARIAT_APP_PRIVATE_KEY', privateKey);
    vi.stubEnv('GITHUB_TOKEN', 'pat-token');
    fetchMock.mockResolvedValueOnce(json({ message: 'nope' }, 401));

    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await expect(resolveGitHubToken()).resolves.toBeNull();
  });

  it('tolerates PEMs stored with escaped newlines', async () => {
    vi.stubEnv('SECRETARIAT_APP_ID', '4234645');
    vi.stubEnv('SECRETARIAT_APP_PRIVATE_KEY', privateKey.replace(/\n/g, '\\n'));
    fetchMock
      .mockResolvedValueOnce(json([{ id: 77 }]))
      .mockResolvedValueOnce(json({ token: 'ghs_minted', expires_at: futureIso(60) }, 201));

    const { resolveGitHubToken } = await import('../../src/addie/jobs/github-app-token.js');
    await expect(resolveGitHubToken()).resolves.toBe('ghs_minted');
  });
});
