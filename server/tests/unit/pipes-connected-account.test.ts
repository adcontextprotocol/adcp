import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet, mockDelete } = vi.hoisted(() => ({ mockGet: vi.fn(), mockDelete: vi.fn() }));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({ get: mockGet, delete: mockDelete }),
}));

const { getGitHubConnectedAccount, disconnectGitHub, buildPipesReturnTo } = await import('../../src/services/pipes.js');

describe('getGitHubConnectedAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns connected with login when WorkOS returns a connected account', async () => {
    mockGet.mockResolvedValueOnce({ external_user_handle: 'octocat' });

    const result = await getGitHubConnectedAccount('user_123');

    expect(result).toEqual({ status: 'connected', login: 'octocat' });
  });

  it('falls back to external_handle when external_user_handle is absent', async () => {
    mockGet.mockResolvedValueOnce({ external_handle: 'octocat2' });

    const result = await getGitHubConnectedAccount('user_123');

    expect(result).toEqual({ status: 'connected', login: 'octocat2' });
  });

  it('returns not_connected when WorkOS returns 404', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockGet.mockRejectedValueOnce(err);

    const result = await getGitHubConnectedAccount('user_123');

    expect(result).toEqual({ status: 'not_connected' });
  });

  it('returns unavailable when WorkOS returns a 5xx error', async () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    mockGet.mockRejectedValueOnce(err);

    const result = await getGitHubConnectedAccount('user_123');

    expect(result.status).toBe('unavailable');
    expect((result as { status: 'unavailable'; reason: string }).reason).toBeTruthy();
  });

  it('returns unavailable for network errors without a status code', async () => {
    mockGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await getGitHubConnectedAccount('user_123');

    expect(result.status).toBe('unavailable');
    expect((result as { status: 'unavailable'; reason: string }).reason).toBeTruthy();
  });
});

describe('buildPipesReturnTo', () => {
  it('builds an absolute URL on top of host + protocol when the path is safe', () => {
    expect(
      buildPipesReturnTo('agenticadvertising.org', 'https', '/member-hub?connected=github'),
    ).toBe('https://agenticadvertising.org/member-hub?connected=github');
  });

  it('falls back to the default path when the requested value is not a string', () => {
    expect(
      buildPipesReturnTo('agenticadvertising.org', 'https', undefined),
    ).toBe('https://agenticadvertising.org/member-hub?connected=github');
    expect(
      buildPipesReturnTo('agenticadvertising.org', 'https', 42 as unknown),
    ).toBe('https://agenticadvertising.org/member-hub?connected=github');
  });

  it.each([
    ['protocol-relative', '//evil.example/owned'],
    ['absolute http', 'http://evil.example/owned'],
    ['backslash-escaped', '/foo\\..\\bar'],
    ['CRLF injection', '/foo\r\nLocation: https://evil.example'],
    ['tab', '/foo\tbar'],
    ['relative path (no leading slash)', 'evil'],
  ])('rejects unsafe return_to (%s) and falls back to default', (_label, payload) => {
    expect(
      buildPipesReturnTo('agenticadvertising.org', 'https', payload),
    ).toBe('https://agenticadvertising.org/member-hub?connected=github');
  });

  it('upgrades plain http to https for non-localhost hosts', () => {
    expect(
      buildPipesReturnTo('agenticadvertising.org', 'http', '/foo'),
    ).toBe('https://agenticadvertising.org/foo');
  });

  it('keeps http for localhost so dev still works', () => {
    expect(
      buildPipesReturnTo('localhost:3000', 'http', '/foo'),
    ).toBe('http://localhost:3000/foo');
  });

  it('honors a caller-supplied default path', () => {
    expect(
      buildPipesReturnTo('agenticadvertising.org', 'https', undefined, '/somewhere-else'),
    ).toBe('https://agenticadvertising.org/somewhere-else');
  });
});

describe('disconnectGitHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns disconnected when WorkOS deletes the connected account', async () => {
    mockDelete.mockResolvedValueOnce(undefined);

    const result = await disconnectGitHub('user_123');

    expect(mockDelete).toHaveBeenCalledWith('/user_management/users/user_123/connected_accounts/github');
    expect(result).toEqual({ status: 'disconnected' });
  });

  it('returns not_connected when WorkOS returns 404', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockDelete.mockRejectedValueOnce(err);

    const result = await disconnectGitHub('user_123');

    expect(result).toEqual({ status: 'not_connected' });
  });

  it('returns unavailable when WorkOS returns a 5xx error', async () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    mockDelete.mockRejectedValueOnce(err);

    const result = await disconnectGitHub('user_123');

    expect(result.status).toBe('unavailable');
    expect((result as { status: 'unavailable'; reason: string }).reason).toBeTruthy();
  });
});
