import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();

vi.mock('../../src/auth/workos-client.js', () => ({
  workos: { get: mockGet },
}));

const { getGitHubConnectedAccount } = await import('../../src/services/pipes.js');

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
  });

  it('returns unavailable for network errors without a status code', async () => {
    mockGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await getGitHubConnectedAccount('user_123');

    expect(result.status).toBe('unavailable');
  });
});
