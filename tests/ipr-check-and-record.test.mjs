import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import YAML from 'yaml';
import { handleIssueComment, handlePullRequestTarget } from '../scripts/ipr/check-and-record.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eventRepo = { owner: 'adcontextprotocol', repo: 'adcp' };
const author = { id: 101, login: 'contributor', type: 'User' };
const signedLedger = {
  signedContributors: [
    { name: 'contributor', id: 101, created_at: '2026-01-02T00:00:00Z', method: 'pr_comment' },
  ],
};
const emptyLedger = { signedContributors: [] };

function fakeGitHub({ pr } = {}) {
  const statuses = [];
  const comments = [];
  return {
    statuses,
    comments,
    getPullRequest: vi.fn(async () => pr),
    async *paginate() {
      for (const c of comments) yield c;
    },
    createIssueComment: vi.fn(async (_o, _r, _n, body) => {
      const c = { id: comments.length + 1, body };
      comments.push(c);
      return c;
    }),
    updateIssueComment: vi.fn(async (_o, _r, id, body) => {
      const c = comments.find((x) => x.id === id);
      c.body = body;
      return c;
    }),
    createStatus: vi.fn(async (_o, _r, sha, { state, context }) => {
      statuses.push({ sha, state, context });
    }),
  };
}

function fakeLedger({ checkout, latest }) {
  return {
    read: vi.fn(() => checkout),
    readLatest: vi.fn(() => latest),
    write: vi.fn(),
    commit: vi.fn(() => true),
  };
}

const prEvent = { pull_request: { number: 42, user: author, head: { sha: 'head-1' } } };

describe('handlePullRequestTarget (check-only path)', () => {
  it('passes an already-signed author from the checkout without re-fetching', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: signedLedger, latest: null });
    await handlePullRequestTarget(gh, prEvent, eventRepo, ledger);
    expect(gh.statuses).toEqual([{ sha: 'head-1', state: 'success', context: 'IPR Policy / Signature' }]);
    expect(ledger.readLatest).not.toHaveBeenCalled();
    expect(ledger.commit).not.toHaveBeenCalled();
  });

  it('never writes the ledger', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: emptyLedger, latest: emptyLedger });
    await handlePullRequestTarget(gh, prEvent, eventRepo, ledger);
    expect(ledger.write).not.toHaveBeenCalled();
    expect(ledger.commit).not.toHaveBeenCalled();
  });

  it('re-reads origin/main after posting pending and flips to success when a signature landed meanwhile', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: emptyLedger, latest: signedLedger });
    await handlePullRequestTarget(gh, prEvent, eventRepo, ledger);
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending', 'success']);
    expect(gh.comments).toHaveLength(0);
  });

  it('stays pending and requests a signature when the author has not signed', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: emptyLedger, latest: emptyLedger });
    await handlePullRequestTarget(gh, prEvent, eventRepo, ledger);
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending']);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain('<!-- ipr-check:request -->');
  });

  it('fails closed (pending) when the fresh re-read fails', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: emptyLedger, latest: null });
    await handlePullRequestTarget(gh, prEvent, eventRepo, ledger);
    expect(gh.statuses.map((s) => s.state)).toEqual(['pending']);
  });

  it('auto-passes bot authors', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: emptyLedger, latest: emptyLedger });
    const event = { pull_request: { number: 7, user: { id: 9, login: 'renovate[bot]', type: 'Bot' }, head: { sha: 'b' } } };
    await handlePullRequestTarget(gh, event, eventRepo, ledger);
    expect(gh.statuses.map((s) => s.state)).toEqual(['success']);
    expect(ledger.read).not.toHaveBeenCalled();
  });
});

describe('handleIssueComment (signature-write path)', () => {
  const commentEvent = {
    issue: { number: 42, pull_request: {} },
    comment: {
      id: 555,
      body: 'I have read the IPR Policy',
      user: author,
      created_at: '2026-10-15T10:00:00Z',
      html_url: 'https://github.com/adcontextprotocol/adcp/pull/42#issuecomment-555',
    },
  };

  it('records the signature and marks both the commented head and a newer head success', async () => {
    const gh = fakeGitHub();
    // First lookup (before the write) sees head-1; the re-read after the push
    // sees head-2, a push that raced the signature.
    gh.getPullRequest
      .mockResolvedValueOnce({ user: author, head: { sha: 'head-1' } })
      .mockResolvedValueOnce({ user: author, head: { sha: 'head-2' } });
    const ledger = fakeLedger({ checkout: emptyLedger, latest: null });
    await handleIssueComment(gh, commentEvent, eventRepo, ledger);

    expect(ledger.write).toHaveBeenCalledTimes(1);
    const written = ledger.write.mock.calls[0][0];
    expect(written.signedContributors.map((c) => c.id)).toEqual([101]);
    expect(ledger.commit).toHaveBeenCalledTimes(1);
    const success = gh.statuses.filter((s) => s.state === 'success').map((s) => s.sha);
    expect(success).toEqual(['head-1', 'head-2']);
  });

  it('marks the head once when it has not moved', async () => {
    const gh = fakeGitHub({ pr: { user: author, head: { sha: 'head-1' } } });
    const ledger = fakeLedger({ checkout: emptyLedger, latest: null });
    await handleIssueComment(gh, commentEvent, eventRepo, ledger);
    expect(gh.statuses.map((s) => s.sha)).toEqual(['head-1']);
  });

  it('ignores a sign phrase from someone other than the PR author', async () => {
    const gh = fakeGitHub({ pr: { user: { id: 202, login: 'owner', type: 'User' }, head: { sha: 'h' } } });
    const ledger = fakeLedger({ checkout: emptyLedger, latest: null });
    await handleIssueComment(gh, commentEvent, eventRepo, ledger);
    expect(ledger.write).not.toHaveBeenCalled();
    expect(gh.statuses).toHaveLength(0);
  });
});

describe('CLI entry point', () => {
  // The workflows run the script directly. If the import guard ever stopped
  // recognizing that, the job would exit 0 without posting a status and the
  // required check would sit pending forever.
  it('runs main() when invoked as a script', () => {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const res = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/ipr/check-and-record.mjs')], {
      cwd: os.tmpdir(),
      env,
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('GitHubClient requires a token');
  });
});

// The required `IPR Policy / Signature` status blocks every merge, so the
// workflow shape is load-bearing: check-only runs must not wait behind each
// other, and only sign-phrase comments may enter the write group.
describe.each([
  ['.github/workflows/ipr-agreement.yml'],
  ['.github/workflows/ipr-check-callable.yml'],
])('%s concurrency shape', (rel) => {
  const wf = YAML.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));

  it('has no workflow-level concurrency group', () => {
    expect(wf.concurrency).toBeUndefined();
  });

  it('runs the check job per PR, cancelling superseded checks', () => {
    const { check } = wf.jobs;
    expect(check.if).toBe("github.event_name == 'pull_request_target'");
    expect(check.concurrency.group).toContain('${{ github.event.pull_request.number }}');
    expect(check.concurrency.group).not.toContain('signature-write');
    expect(check.concurrency['cancel-in-progress']).toBe(true);
  });

  it('serializes only sign-phrase comments in the write group', () => {
    const { record } = wf.jobs;
    expect(record.if).toContain("github.event_name == 'issue_comment'");
    expect(record.if).toContain('github.event.issue.pull_request != null');
    expect(record.if).toContain("contains(github.event.comment.body, 'I have read the IPR Policy')");
    expect(record.concurrency).toEqual({
      group: 'adcp-ipr-signature-write',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });

  it('has exactly the check and record jobs', () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(['check', 'record']);
  });
});
