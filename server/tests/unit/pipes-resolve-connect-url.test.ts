import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAccessToken, mockPost } = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({
    pipes: { getAccessToken: mockGetAccessToken },
    post: mockPost,
  }),
}));

const { resolveGitHubConnectUrl } = await import('../../src/services/pipes.js');

describe('resolveGitHubConnectUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns already_connected without calling authorize when user has an active token with all scopes', async () => {
    mockGetAccessToken.mockResolvedValueOnce({
      active: true,
      accessToken: { accessToken: 'ghs_xxx', scopes: ['repo'], missingScopes: [] },
    });

    const result = await resolveGitHubConnectUrl('user_123', 'https://example.com/member-hub?connected=github');

    expect(result).toEqual({
      status: 'already_connected',
      url: 'https://example.com/member-hub?connected=github',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('calls authorize when the active token is missing required scopes', async () => {
    mockGetAccessToken.mockResolvedValueOnce({
      active: true,
      accessToken: { accessToken: 'ghs_xxx', scopes: ['repo'], missingScopes: ['workflow'] },
    });
    mockPost.mockResolvedValueOnce({ data: { url: 'https://auth.example/authorize-x' } });

    const result = await resolveGitHubConnectUrl('user_123', 'https://example.com/member-hub?connected=github');

    expect(result).toEqual({ status: 'authorize', url: 'https://auth.example/authorize-x' });
    expect(mockPost).toHaveBeenCalledOnce();
  });

  it('calls authorize when the user is not yet connected', async () => {
    mockGetAccessToken.mockResolvedValue({ active: false, error: 'not_installed' });
    mockPost.mockResolvedValueOnce({ data: { url: 'https://auth.example/authorize-y' } });

    const result = await resolveGitHubConnectUrl('user_123', 'https://example.com/member-hub?connected=github');

    expect(result).toEqual({ status: 'authorize', url: 'https://auth.example/authorize-y' });
  });

  it('treats WorkOS 400 "User has already installed this integration" as already_connected (TOCTOU)', async () => {
    mockGetAccessToken.mockResolvedValue({ active: false, error: 'not_installed' });
    const err = Object.assign(new Error('Bad Request'), {
      status: 400,
      rawData: { message: 'User has already installed this integration', error: 'Bad Request' },
    });
    mockPost.mockRejectedValueOnce(err);

    const result = await resolveGitHubConnectUrl('user_123', 'https://example.com/member-hub?connected=github');

    expect(result).toEqual({
      status: 'already_connected',
      url: 'https://example.com/member-hub?connected=github',
    });
  });

  it('rethrows non-recoverable WorkOS errors', async () => {
    mockGetAccessToken.mockResolvedValue({ active: false, error: 'not_installed' });
    mockPost.mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }));

    await expect(
      resolveGitHubConnectUrl('user_123', 'https://example.com/member-hub?connected=github'),
    ).rejects.toThrow('Service Unavailable');
  });

  it('rethrows 400s with a different message rather than swallowing them', async () => {
    mockGetAccessToken.mockResolvedValue({ active: false, error: 'not_installed' });
    const err = Object.assign(new Error('Bad Request'), {
      status: 400,
      rawData: { message: 'Invalid return_to', error: 'Bad Request' },
    });
    mockPost.mockRejectedValueOnce(err);

    await expect(
      resolveGitHubConnectUrl('user_123', 'https://example.com/member-hub?connected=github'),
    ).rejects.toThrow('Bad Request');
  });
});
