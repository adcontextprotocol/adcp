import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
}));

import { createEscalation } from '../../src/db/escalation-db.js';
import { fileGitHubIssue } from '../../src/addie/jobs/github-filer.js';

describe('support redaction call sites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'unit-test-github-token';
  });

  it('redacts GitHub issue title and body before posting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        html_url: 'https://github.com/adcontextprotocol/adcp/issues/1',
        number: 1,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fileGitHubIssue({
      title: 'Domain stuck verification_token: super-secret-token-1234567890',
      body: '- Value: `wos-domain-verification=abcdef1234567890abcdef`',
      repo: 'adcontextprotocol/adcp',
    });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.title).toContain('[redacted-verification-token]');
    expect(payload.body).toContain('[redacted-verification-token]');
    expect(JSON.stringify(payload)).not.toContain('super-secret-token-1234567890');
    expect(JSON.stringify(payload)).not.toContain('abcdef1234567890abcdef');
  });

  it('redacts escalation fields before persistence', async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        id: 123,
        summary: 'redacted row',
      }],
    });

    const bearerToken = ['abcdefgh', 'ijklmnop'].join('');
    await createEscalation({
      category: 'needs_human_action',
      priority: 'high',
      summary: 'Domain stuck verification_token: super-secret-token-1234567890',
      original_request: '- Value: `wos-domain-verification=abcdef1234567890abcdef`',
      addie_context: `Bearer ${bearerToken}`,
    });

    const params = mocks.query.mock.calls[0][1];
    expect(params[9]).toContain('[redacted-verification-token]');
    expect(params[10]).toContain('[redacted-verification-token]');
    expect(params[11]).toContain('Bearer [redacted-secret]');
    expect(JSON.stringify(params)).not.toContain('super-secret-token-1234567890');
    expect(JSON.stringify(params)).not.toContain('abcdef1234567890abcdef');
    expect(JSON.stringify(params)).not.toContain(bearerToken);
  });
});
