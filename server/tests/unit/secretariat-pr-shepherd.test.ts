import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveGitHubToken = vi.fn();
const propose = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../src/addie/jobs/github-app-token.js', () => ({
  resolveGitHubToken,
}));

vi.mock('../../src/db/secretariat-actions-db.js', () => ({
  propose,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function pr(number: number, ageDays: number, sha = `sha-${number}`) {
  return { number, created_at: daysAgoIso(ageDays), user: { login: `author${number}` }, head: { sha } };
}

function statusResponse(state: string | null) {
  return { statuses: state ? [{ context: 'IPR Policy / Signature', state }] : [] };
}

describe('runSecretariatPrShepherdJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    resolveGitHubToken.mockResolvedValue('test-token');
    propose.mockResolvedValue({ id: 'proposed-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proposes an IPR nudge for a PR older than 7 days with a pending status', async () => {
    fetchMock
      .mockResolvedValueOnce(json([pr(101, 10)])) // PR list
      .mockResolvedValueOnce(json(statusResponse('pending'))); // combined status

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result.prsScanned).toBe(1);
    expect(result.proposed).toBe(1);
    expect(propose).toHaveBeenCalledTimes(1);
    const call = propose.mock.calls[0][0];
    expect(call.kind).toBe('post_issue_comment');
    expect(call.origin).toBe('secretariat-pr-shepherd');
    expect(call.dedupe_key).toBe('ipr-nudge:101');
    expect(call.payload.issueNumber).toBe(101);
    expect(call.payload.body).toContain('I have read the IPR Policy');
  });

  it('does not propose a duplicate nudge for the same PR — dedupe_key is stable per PR number', async () => {
    fetchMock
      .mockResolvedValueOnce(json([pr(101, 10)]))
      .mockResolvedValueOnce(json(statusResponse('pending')))
      .mockResolvedValueOnce(json([pr(101, 11)])) // second sweep, PR aged one more day
      .mockResolvedValueOnce(json(statusResponse('pending')));

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    await runSecretariatPrShepherdJob();
    await runSecretariatPrShepherdJob();

    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[0][0].dedupe_key).toBe('ipr-nudge:101');
    expect(propose.mock.calls[1][0].dedupe_key).toBe('ipr-nudge:101');
    // The actual de-duplication is enforced at the DB layer (unique dedupe_key,
    // see secretariat-actions-db.test.ts) — the job's contract is to always
    // propose with the same stable key so the DB can no-op the second call.
  });

  it('skips a PR younger than the minimum age without checking its status', async () => {
    fetchMock.mockResolvedValueOnce(json([pr(202, 2)]));

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result.skippedTooNew).toBe(1);
    expect(result.proposed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the PR list call
    expect(propose).not.toHaveBeenCalled();
  });

  it('skips a PR whose IPR status is not pending', async () => {
    fetchMock
      .mockResolvedValueOnce(json([pr(303, 10)]))
      .mockResolvedValueOnce(json(statusResponse('success')));

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result.skippedNotPending).toBe(1);
    expect(propose).not.toHaveBeenCalled();
  });

  it('is resilient to a status lookup failure: skips that PR, keeps processing others, never throws', async () => {
    fetchMock
      .mockResolvedValueOnce(json([pr(404, 10), pr(405, 10)])) // PR list
      .mockResolvedValueOnce(json({ message: 'boom' }, 500)) // status lookup for 404 fails
      .mockResolvedValueOnce(json(statusResponse('pending'))); // status lookup for 405 succeeds

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result.skippedLookupFailed).toBe(1);
    expect(result.proposed).toBe(1);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][0].dedupe_key).toBe('ipr-nudge:405');
  });

  it('is resilient when the status lookup throws (network error)', async () => {
    fetchMock
      .mockResolvedValueOnce(json([pr(500, 10)]))
      .mockRejectedValueOnce(new Error('network down'));

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result.skippedLookupFailed).toBe(1);
    expect(propose).not.toHaveBeenCalled();
  });

  it('returns early without calling GitHub when no credential is available', async () => {
    resolveGitHubToken.mockResolvedValue(null);

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result).toEqual({ prsScanned: 0, proposed: 0, skippedNotPending: 0, skippedTooNew: 0, skippedLookupFailed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns early when the PR list lookup fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'nope' }, 500));

    const { runSecretariatPrShepherdJob } = await import('../../src/addie/jobs/secretariat-pr-shepherd.js');
    const result = await runSecretariatPrShepherdJob();

    expect(result.prsScanned).toBe(0);
    expect(propose).not.toHaveBeenCalled();
  });
});
