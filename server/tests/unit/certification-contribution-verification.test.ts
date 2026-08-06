import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, resolveGitHubToken } = vi.hoisted(() => ({
  query: vi.fn(),
  resolveGitHubToken: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({ query }));
vi.mock('../../src/addie/jobs/github-app-token.js', () => ({ resolveGitHubToken }));

import { confirmCertificationContribution } from '../../src/services/certification-experience.js';

const contribution = {
  id: 'contribution-1',
  module_id: 'module-1',
  repository: 'adcontextprotocol/adcp',
  title: 'Clarify the certification guide',
  status: 'drafted',
  draft_url: null,
  github_issue_number: null,
  github_issue_url: null,
  created_at: '2026-08-06T00:00:00.000Z',
  updated_at: '2026-08-06T00:00:00.000Z',
};

describe('certification contribution verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [contribution] });
    resolveGitHubToken.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds the GitHub request and turns timeouts into a retryable error', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    );

    await expect(confirmCertificationContribution(
      'user-1',
      contribution.id,
      'https://github.com/adcontextprotocol/adcp/issues/123',
    )).rejects.toThrow('That GitHub issue could not be verified. Please try again.');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/adcontextprotocol/adcp/issues/123',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('uses the configured GitHub credential and explains rate-limit failures', async () => {
    resolveGitHubToken.mockResolvedValue('github-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '0' }),
    } as Response);

    await expect(confirmCertificationContribution(
      'user-1',
      contribution.id,
      'https://github.com/adcontextprotocol/adcp/issues/123',
    )).rejects.toThrow('GitHub verification is temporarily rate limited. Please try again in a few minutes.');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/adcontextprotocol/adcp/issues/123',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer github-token' }),
      }),
    );
  });

  it('explains GitHub secondary rate-limit failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'retry-after': '60' }),
    } as Response);

    await expect(confirmCertificationContribution(
      'user-1',
      contribution.id,
      'https://github.com/adcontextprotocol/adcp/issues/123',
    )).rejects.toThrow('GitHub verification is temporarily rate limited. Please try again in a few minutes.');
  });

  it('turns response-body timeouts into a retryable error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError')),
    } as unknown as Response);

    await expect(confirmCertificationContribution(
      'user-1',
      contribution.id,
      'https://github.com/adcontextprotocol/adcp/issues/123',
    )).rejects.toThrow('That GitHub issue could not be verified. Please try again.');
  });

  it('accepts a successful response that consumes the last rate-limit request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-ratelimit-remaining': '0' }),
      json: vi.fn().mockResolvedValue({
        title: contribution.title,
        html_url: 'https://github.com/adcontextprotocol/adcp/issues/123',
      }),
    } as unknown as Response);

    await expect(confirmCertificationContribution(
      'user-1',
      contribution.id,
      'https://github.com/adcontextprotocol/adcp/issues/123',
    )).resolves.toEqual(contribution);
  });
});
