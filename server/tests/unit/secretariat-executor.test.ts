import { describe, it, expect, vi, beforeEach } from 'vitest';

const listByStatus = vi.fn();
const claimForExecution = vi.fn();
const markDone = vi.fn();
const markFailed = vi.fn();
const upsertFilesPr = vi.fn();
const fileGitHubIssue = vi.fn();
const postIssueComment = vi.fn();
const sendChannelMessage = vi.fn();

vi.mock('../../src/db/secretariat-actions-db.js', () => ({
  listByStatus,
  claimForExecution,
  markDone,
  markFailed,
}));

vi.mock('../../src/addie/jobs/github-pr.js', () => ({
  upsertFilesPr,
}));

vi.mock('../../src/addie/jobs/github-filer.js', () => ({
  fileGitHubIssue,
  postIssueComment,
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage,
}));

function action(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'a1',
    kind: 'file_issue',
    title: 't',
    rationale: 'r',
    payload: {},
    status: 'approved',
    origin: 'test',
    dedupe_key: null,
    edited: false,
    result: null,
    error: null,
    decided_by: 'admin@example.com',
    decided_at: new Date(),
    executed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('runSecretariatExecutorJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches open_pr to upsertFilesPr and marks done with the PR result', async () => {
    const openPrAction = action({
      id: 'a-open-pr',
      kind: 'open_pr',
      payload: {
        branch: 'addie/x',
        files: [{ path: 'a.md', content: 'hi' }],
        commitMessage: 'chore: x',
        prTitle: 'chore: x',
        prBody: 'body',
      },
    });
    listByStatus.mockResolvedValue([openPrAction]);
    claimForExecution.mockResolvedValue({ ...openPrAction, status: 'executing' });
    upsertFilesPr.mockResolvedValue({ prUrl: 'https://github.com/x/pr/1', prNumber: 1, created: true });

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    const result = await runSecretariatExecutorJob();

    expect(upsertFilesPr).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'addie/x',
      files: [{ path: 'a.md', content: 'hi' }],
      commitMessage: 'chore: x',
      prTitle: 'chore: x',
      prBody: 'body',
    }));
    expect(markDone).toHaveBeenCalledWith('a-open-pr', { prUrl: 'https://github.com/x/pr/1', prNumber: 1, created: true });
    expect(result).toEqual({ claimed: 1, executed: 1, failed: 0 });
  });

  it('dispatches post_issue_comment to postIssueComment and marks done with the comment result', async () => {
    const commentAction = action({
      id: 'a-comment',
      kind: 'post_issue_comment',
      payload: { repo: 'acme/spec', issueNumber: 42, body: 'hello' },
    });
    listByStatus.mockResolvedValue([commentAction]);
    claimForExecution.mockResolvedValue({ ...commentAction, status: 'executing' });
    postIssueComment.mockResolvedValue({ url: 'https://github.com/acme/spec/pull/42#comment-1', id: 1 });

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    await runSecretariatExecutorJob();

    expect(postIssueComment).toHaveBeenCalledWith({ repo: 'acme/spec', issueNumber: 42, body: 'hello' });
    expect(markDone).toHaveBeenCalledWith('a-comment', { commentUrl: 'https://github.com/acme/spec/pull/42#comment-1', commentId: 1 });
  });

  it('dispatches file_issue to fileGitHubIssue and marks done with the issue result', async () => {
    const fileIssueAction = action({
      id: 'a-file-issue',
      kind: 'file_issue',
      payload: { title: 'Bug', body: 'desc', labels: ['bug'] },
    });
    listByStatus.mockResolvedValue([fileIssueAction]);
    claimForExecution.mockResolvedValue({ ...fileIssueAction, status: 'executing' });
    fileGitHubIssue.mockResolvedValue({ url: 'https://github.com/acme/spec/issues/9', number: 9, repo: 'acme/spec' });

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    await runSecretariatExecutorJob();

    expect(fileGitHubIssue).toHaveBeenCalledWith({ repo: undefined, title: 'Bug', body: 'desc', labels: ['bug'] });
    expect(markDone).toHaveBeenCalledWith('a-file-issue', { issueUrl: 'https://github.com/acme/spec/issues/9', issueNumber: 9 });
  });

  it('dispatches post_slack_message to sendChannelMessage and marks done with the ts', async () => {
    const slackAction = action({
      id: 'a-slack',
      kind: 'post_slack_message',
      payload: { channelId: 'C123', text: 'hi there' },
    });
    listByStatus.mockResolvedValue([slackAction]);
    claimForExecution.mockResolvedValue({ ...slackAction, status: 'executing' });
    sendChannelMessage.mockResolvedValue({ ok: true, ts: '123.456' });

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    await runSecretariatExecutorJob();

    expect(sendChannelMessage).toHaveBeenCalledWith('C123', { text: 'hi there' });
    expect(markDone).toHaveBeenCalledWith('a-slack', { slackTs: '123.456' });
  });

  it('fails closed on an unknown or disallowed kind', async () => {
    const weirdAction = action({ id: 'a-weird', kind: 'merge_pr' as unknown as string, payload: {} });
    listByStatus.mockResolvedValue([weirdAction]);
    claimForExecution.mockResolvedValue({ ...weirdAction, status: 'executing' });

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    const result = await runSecretariatExecutorJob();

    expect(upsertFilesPr).not.toHaveBeenCalled();
    expect(fileGitHubIssue).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
    expect(sendChannelMessage).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('a-weird', expect.stringContaining('Unknown or disallowed action kind'));
    expect(result).toEqual({ claimed: 1, executed: 0, failed: 1 });
  });

  it('marks failed when the underlying seam returns null (e.g. no GitHub credential)', async () => {
    const openPrAction = action({
      id: 'a-open-pr-fail',
      kind: 'open_pr',
      payload: { branch: 'addie/x', files: [{ path: 'a.md', content: 'hi' }], commitMessage: 'm', prTitle: 't', prBody: 'b' },
    });
    listByStatus.mockResolvedValue([openPrAction]);
    claimForExecution.mockResolvedValue({ ...openPrAction, status: 'executing' });
    upsertFilesPr.mockResolvedValue(null);

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    const result = await runSecretariatExecutorJob();

    expect(markFailed).toHaveBeenCalledWith('a-open-pr-fail', expect.stringContaining('upsertFilesPr failed'));
    expect(result).toEqual({ claimed: 1, executed: 0, failed: 1 });
  });

  it('marks failed when the payload is malformed for the kind', async () => {
    const badAction = action({ id: 'a-bad-payload', kind: 'file_issue', payload: { title: 'ok' } }); // missing body
    listByStatus.mockResolvedValue([badAction]);
    claimForExecution.mockResolvedValue({ ...badAction, status: 'executing' });

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    const result = await runSecretariatExecutorJob();

    expect(fileGitHubIssue).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('a-bad-payload', expect.stringContaining('body'));
    expect(result).toEqual({ claimed: 1, executed: 0, failed: 1 });
  });

  it('skips (does not execute) an action it fails to claim — the double-execution guard', async () => {
    const raceAction = action({ id: 'a-race', kind: 'file_issue', payload: { title: 't', body: 'b' } });
    listByStatus.mockResolvedValue([raceAction]);
    claimForExecution.mockResolvedValue(null); // another tick/instance already claimed it

    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    const result = await runSecretariatExecutorJob();

    expect(fileGitHubIssue).not.toHaveBeenCalled();
    expect(markDone).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, executed: 0, failed: 0 });
  });

  it('passes the limit option through to listByStatus', async () => {
    listByStatus.mockResolvedValue([]);
    const { runSecretariatExecutorJob } = await import('../../src/addie/jobs/secretariat-executor.js');
    await runSecretariatExecutorJob({ limit: 3 });
    expect(listByStatus).toHaveBeenCalledWith({ status: 'approved', limit: 3 });
  });
});
