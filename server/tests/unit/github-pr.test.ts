import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('upsertFilePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPO', 'acme/spec');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const input = {
    branch: 'addie/wg-slack-context',
    path: '.agents/wg/slack-context.md',
    content: '# digest\n',
    commitMessage: 'chore: refresh',
    prTitle: 'chore: refresh',
    prBody: 'body',
  };

  it('creates branch, commits file, and opens a new PR', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ object: { sha: 'base-sha' } })) // GET base ref
      .mockResolvedValueOnce(json({}, 201)) // POST create branch
      .mockResolvedValueOnce(json({}, 404)) // GET file on branch (absent)
      .mockResolvedValueOnce(json({ commit: { sha: 'c1' } })) // PUT contents
      .mockResolvedValueOnce(json([])) // GET open PRs (none)
      .mockResolvedValueOnce(json({ html_url: 'https://github.com/acme/spec/pull/9', number: 9 }, 201));

    const { upsertFilePr } = await import('../../src/addie/jobs/github-pr.js');
    const result = await upsertFilePr(input);

    expect(result).toEqual({ prUrl: 'https://github.com/acme/spec/pull/9', prNumber: 9, created: true });

    const putCall = fetchMock.mock.calls[3];
    expect(putCall[0]).toContain('/contents/.agents/wg/slack-context.md');
    const putBody = JSON.parse(putCall[1].body as string);
    expect(putBody.branch).toBe('addie/wg-slack-context');
    expect(putBody.sha).toBeUndefined();
    expect(Buffer.from(putBody.content, 'base64').toString('utf8')).toBe('# digest\n');
  });

  it('force-resets an existing branch and reuses the open PR', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ object: { sha: 'base-sha' } })) // GET base ref
      .mockResolvedValueOnce(json({ message: 'Reference already exists' }, 422)) // POST create branch
      .mockResolvedValueOnce(json({}, 200)) // PATCH force-reset
      .mockResolvedValueOnce(json({ sha: 'blob-sha' })) // GET file on branch
      .mockResolvedValueOnce(json({ commit: { sha: 'c2' } })) // PUT contents
      .mockResolvedValueOnce(json([{ html_url: 'https://github.com/acme/spec/pull/7', number: 7 }])); // GET open PRs

    const { upsertFilePr } = await import('../../src/addie/jobs/github-pr.js');
    const result = await upsertFilePr(input);

    expect(result).toEqual({ prUrl: 'https://github.com/acme/spec/pull/7', prNumber: 7, created: false });

    const patchCall = fetchMock.mock.calls[2];
    expect(patchCall[0]).toContain('/git/refs/heads/addie/wg-slack-context');
    expect(JSON.parse(patchCall[1].body as string)).toEqual({ sha: 'base-sha', force: true });

    const putBody = JSON.parse(fetchMock.mock.calls[4][1].body as string);
    expect(putBody.sha).toBe('blob-sha');

    // No PR creation call after finding the open PR.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('returns null without calling GitHub when the token is missing', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const { upsertFilePr } = await import('../../src/addie/jobs/github-pr.js');
    const result = await upsertFilePr(input);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getFileContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPO', 'acme/spec');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('decodes base64 content', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ content: Buffer.from('hello\n', 'utf8').toString('base64') })
    );
    const { getFileContent } = await import('../../src/addie/jobs/github-pr.js');
    await expect(getFileContent('a.md', 'main')).resolves.toBe('hello\n');
  });

  it('returns null for a missing file', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    const { getFileContent } = await import('../../src/addie/jobs/github-pr.js');
    await expect(getFileContent('missing.md', 'main')).resolves.toBeNull();
  });

  it('throws on non-404 failures so callers can tell absent from unreadable', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'boom' }, 500));
    const { getFileContent } = await import('../../src/addie/jobs/github-pr.js');
    await expect(getFileContent('a.md', 'main')).rejects.toThrow('500');
  });
});
