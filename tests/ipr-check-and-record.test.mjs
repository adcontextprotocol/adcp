import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import YAML from 'yaml';
import {
  createGitLedger,
  handleIssueComment,
  handlePullRequestTarget,
  recordSignatureWithRetry,
} from '../scripts/ipr/check-and-record.mjs';
import { SIGNATURES_PATH, parseSignatures, writeSignatures } from '../scripts/ipr/signatures.mjs';

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
    record: vi.fn(async () => ({ recorded: true })),
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
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('never writes the ledger', async () => {
    const gh = fakeGitHub();
    const ledger = fakeLedger({ checkout: emptyLedger, latest: emptyLedger });
    await handlePullRequestTarget(gh, prEvent, eventRepo, ledger);
    expect(ledger.record).not.toHaveBeenCalled();
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

    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][0]).toMatchObject({ id: 101, name: 'contributor', method: 'pr_comment' });
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
    expect(ledger.record).not.toHaveBeenCalled();
    expect(gh.statuses).toHaveLength(0);
  });
});

// Several AAO repos call ipr-check-callable.yml, and Actions concurrency groups
// are per repo, so two signature writes can reach the shared ledger at the same
// time. These tests use real git against a local bare remote.
describe('recording a signature when another repo pushed first', () => {
  const tmpRoots = [];

  beforeAll(() => {
    // Inside a git hook, GIT_DIR and friends would point every git call
    // (including the script's) at the enclosing repository.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const g = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const seedSignature = { name: 'seed', id: 1, created_at: '2026-01-01T00:00:00Z', method: 'pr_comment' };

  // A bare "origin" seeded with one signature, plus two shallow clones taken at
  // the same commit, the way two workflow runs check out main.
  function setupRemote() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipr-ledger-'));
    tmpRoots.push(root);
    g(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    const remote = `file://${path.join(root, 'origin.git')}`;
    const seed = path.join(root, 'seed');
    g(root, 'clone', '-q', remote, 'seed');
    writeSignatures({ signedContributors: [seedSignature] }, seed);
    g(seed, 'add', '.');
    g(seed, 'commit', '-q', '-m', 'seed ledger');
    g(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    g(root, 'clone', '-q', '--depth=1', remote, 'run-a');
    g(root, 'clone', '-q', '--depth=1', remote, 'run-b');
    return {
      root,
      runA: path.join(root, 'run-a'),
      runB: path.join(root, 'run-b'),
      remoteLedger: () => parseSignatures(g(path.join(root, 'origin.git'), 'show', `main:${SIGNATURES_PATH}`)),
      remoteHead: () => g(path.join(root, 'origin.git'), 'rev-parse', 'main').trim(),
    };
  }

  const noWait = { sleep: async () => {} };
  const otherRepoEntry = (id, login) => ({
    name: login,
    id,
    created_at: '2026-10-15T10:00:01Z',
    method: 'pr_comment',
    repo: 'adcontextprotocol/adcp-client',
    pullRequestNo: 9,
  });

  function commentEvent() {
    return {
      issue: { number: 42, pull_request: {} },
      comment: {
        id: 555,
        body: 'I have read the IPR Policy',
        user: author,
        created_at: '2026-10-15T10:00:00Z',
        html_url: 'https://github.com/adcontextprotocol/adcp/pull/42#issuecomment-555',
      },
    };
  }

  it('re-applies the signature on the new head instead of rebasing a conflicting append', async () => {
    const env = setupRemote();
    // Run B (another repo) records first. Run A's checkout still predates it,
    // so A's first push is rejected and both appends edit the same lines.
    const runB = createGitLedger(env.runB, { assertRemote: false, retry: noWait });
    await expect(runB.record(otherRepoEntry(202, 'other-repo-signer'), 'record b')).resolves.toEqual({ recorded: true });

    const gh = fakeGitHub({ pr: { user: author, head: { sha: 'head-1' } } });
    const runA = createGitLedger(env.runA, { assertRemote: false, retry: noWait });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleIssueComment(gh, commentEvent(), eventRepo, runA);

    expect(warn.mock.calls.map(([m]) => m)).toEqual([expect.stringMatching(/^Attempt 1\/5: push rejected/)]);
    const ids = env.remoteLedger().signedContributors.map((c) => c.id);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 101, 202]);
    // The ledger stays in writeSignatures' format (sorted, 2-space, newline).
    const onDisk = fs.readFileSync(path.join(env.runA, SIGNATURES_PATH), 'utf8');
    expect(g(path.join(env.root, 'origin.git'), 'show', `main:${SIGNATURES_PATH}`)).toBe(onDisk);
    expect(gh.statuses).toEqual([{ sha: 'head-1', state: 'success', context: 'IPR Policy / Signature' }]);
  });

  it('does not write again when a concurrent run already recorded the same author', async () => {
    const env = setupRemote();
    // The same author signed on another repo's PR at the same moment.
    const runB = createGitLedger(env.runB, { assertRemote: false, retry: noWait });
    await runB.record(otherRepoEntry(author.id, author.login), 'record b');
    const headAfterB = env.remoteHead();

    const gh = fakeGitHub();
    gh.getPullRequest
      .mockResolvedValueOnce({ user: author, head: { sha: 'head-1' } })
      .mockResolvedValueOnce({ user: author, head: { sha: 'head-2' } });
    const runA = createGitLedger(env.runA, { assertRemote: false, retry: noWait });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleIssueComment(gh, commentEvent(), eventRepo, runA);

    expect(warn.mock.calls.map(([m]) => m)).toEqual([expect.stringMatching(/^Attempt 1\/5: push rejected/)]);
    expect(env.remoteHead()).toBe(headAfterB);
    const entries = env.remoteLedger().signedContributors.filter((c) => c.id === author.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].repo).toBe('adcontextprotocol/adcp-client');
    // The post-write status behaviour is unchanged: both heads get success.
    expect(gh.statuses.map((s) => [s.sha, s.state])).toEqual([
      ['head-1', 'success'],
      ['head-2', 'success'],
    ]);
  });

  it('returns already-recorded from the retry loop without committing', async () => {
    let ledger = { signedContributors: [seedSignature] };
    const ops = {
      sync: vi.fn(() => {
        ledger = { signedContributors: [seedSignature, { ...otherRepoEntry(101, 'contributor') }] };
      }),
      read: vi.fn(() => ledger),
      write: vi.fn(),
      commit: vi.fn(() => true),
      push: vi.fn(() => {
        throw new Error('! [rejected] HEAD -> main (fetch first)');
      }),
    };
    const result = await recordSignatureWithRetry(ops, { ...otherRepoEntry(101, 'contributor') }, 'm', noWait);
    expect(result.recorded).toBe(false);
    expect(result.existing.id).toBe(101);
    expect(ops.commit).toHaveBeenCalledTimes(1);
    expect(ops.push).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded number of attempts, backing off between them', async () => {
    const ops = {
      sync: vi.fn(),
      read: vi.fn(() => ({ signedContributors: [seedSignature] })),
      write: vi.fn(),
      commit: vi.fn(() => true),
      push: vi.fn(() => {
        throw new Error('! [rejected] HEAD -> main (fetch first)');
      }),
    };
    const sleep = vi.fn(async () => {});
    const backoff = vi.fn((retry) => retry * 100);

    await expect(
      recordSignatureWithRetry(ops, otherRepoEntry(101, 'contributor'), 'm', { maxAttempts: 3, sleep, backoff }),
    ).rejects.toThrow(/after 3 attempts.*rejected/);
    expect(ops.push).toHaveBeenCalledTimes(3);
    // Every retry starts from the fresh remote head and re-applies the entry.
    expect(ops.sync).toHaveBeenCalledTimes(2);
    expect(ops.write).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it('posts no success status when recording fails', async () => {
    const gh = fakeGitHub({ pr: { user: author, head: { sha: 'head-1' } } });
    const ledger = fakeLedger({ checkout: emptyLedger, latest: null });
    ledger.record.mockRejectedValueOnce(new Error('Failed to record signature after 5 attempts'));
    await expect(handleIssueComment(gh, commentEvent(), eventRepo, ledger)).rejects.toThrow(/5 attempts/);
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
