#!/usr/bin/env node
/**
 * IPR signature check-and-record.
 *
 * Runs inside a GitHub Actions workflow on `issue_comment` and
 * `pull_request_target` events. Reads the event payload via
 * GITHUB_EVENT_PATH, consults `signatures/ipr-signatures.json`, records new
 * signatures, and sets the commit status the branch protection rule depends on.
 *
 * Environment:
 *   GITHUB_TOKEN         — auth for API calls on the event repo
 *                          (pull-requests:write + statuses:write).
 *   GITHUB_EVENT_NAME    — "issue_comment" | "pull_request_target"
 *   GITHUB_EVENT_PATH    — path to the event JSON
 *   GITHUB_REPOSITORY    — "owner/repo" — the EVENT repo (where the PR lives)
 *   LEDGER_DIR           — optional path to a checked-out clone of the central
 *                          ledger repo (adcontextprotocol/adcp). When set, the
 *                          script reads/writes signatures there and commits via
 *                          git in that directory — the directory's `origin`
 *                          remote must already be authenticated for push (e.g.
 *                          via a GitHub App installation token configured by
 *                          the calling workflow's `actions/checkout` step).
 *                          Defaults to the current working directory, which is
 *                          the right behavior when the event repo IS the
 *                          ledger repo (adcp itself).
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from './github.mjs';
import { isLedgerRemoteAllowed } from './ledger-remote.mjs';
import {
  SIGN_PHRASE,
  SIGNATURES_PATH,
  addSignature,
  findSignature,
  hasSigned,
  isSignPhrase,
  parseSignatures,
  readSignatures,
  writeSignatures,
} from './signatures.mjs';

const STATUS_CONTEXT = 'IPR Policy / Signature';
const CLAIM_COMMENT_MARKER = '<!-- ipr-check:request -->';
const CONFIRM_COMMENT_MARKER = '<!-- ipr-check:confirmed -->';
const WRONG_SIGNER_COMMENT_MARKER = '<!-- ipr-check:wrong-signer -->';

// LEDGER_DIR is where the central ipr-signatures.json lives on disk. When the
// workflow runs inside the event repo (e.g. adcp-client), the calling workflow
// checks out adcontextprotocol/adcp into a sub-directory and points us at it
// via env. When the event repo IS the ledger (adcp), it defaults to cwd and
// no extra checkout is required.
const LEDGER_DIR = process.env.LEDGER_DIR || process.cwd();

const BOT_LOGIN_SUFFIX = '[bot]';
const EXTRA_BOT_LOGINS = new Set([
  'dependabot',
  'renovate',
  'github-actions',
]);

function isBot(user) {
  if (!user) return true;
  if (user.type === 'Bot') return true;
  if (user.login && user.login.endsWith(BOT_LOGIN_SUFFIX)) return true;
  if (user.login && EXTRA_BOT_LOGINS.has(user.login.toLowerCase())) return true;
  return false;
}

function loadEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH not set');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function parseRepoSlug(slug) {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo slug: ${slug}`);
  return { owner, repo };
}

function git(args, { cwd = LEDGER_DIR, ...opts } = {}) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...opts,
  });
}

function configureGitIdentity(dir) {
  git(['config', 'user.name', 'github-actions[bot]'], { cwd: dir });
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: dir });
}

// The ledger-remote guard protects the push target. Asserting the remote URL
// here removes a class of "future workflow edit changes which checkout backs
// LEDGER_DIR" footguns. The accept/reject matrix lives in
// tests/ipr-ledger-remote.test.mjs.
function assertLedgerRemote(dir) {
  let url;
  try {
    url = git(['remote', 'get-url', 'origin'], { cwd: dir }).trim();
  } catch (err) {
    throw new Error(`LEDGER_DIR ${dir} has no \`origin\` remote: ${err.message ?? err}`);
  }
  if (!isLedgerRemoteAllowed(url)) {
    throw new Error(
      `Refusing to push: LEDGER_DIR origin (${url}) is not adcontextprotocol/adcp.`,
    );
  }
}

// GitHub Actions concurrency groups are per repo. The write group serializes
// signature writes within one repo, but every AAO repo that calls
// ipr-check-callable.yml writes the same ledger, so writes from different repos
// can still race. This retry loop handles that race. Five attempts covers
// realistic contention from about five repos.
export const RECORD_MAX_ATTEMPTS = 5;
const RECORD_BASE_DELAY_MS = 1000;

// Exponential backoff plus jitter, so two writers that collided once do not
// retry on the same schedule.
function defaultBackoff(retry) {
  return RECORD_BASE_DELAY_MS * 2 ** (retry - 1) + Math.floor(Math.random() * RECORD_BASE_DELAY_MS);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append `entry` to the ledger and push it, retrying when the push is rejected.
 *
 * Each attempt applies the signature to a fresh copy of the ledger instead of
 * replaying a commit. Two signatures appended to the same JSON array at the
 * same time edit the same lines, so a rebase conflicts. After a rejected push,
 * the next attempt resets to the new remote head, re-reads the ledger, and adds
 * the entry again. If the author is already on the fresh ledger (another run
 * recorded them first), it returns without writing.
 *
 * `ops` is the git-facing surface:
 *   sync()          move the checkout to the remote head
 *   read()/write()  the ledger file
 *   commit(message) returns false when there is nothing to commit
 *   push()          throws on rejection
 *
 * Resolves to `{ recorded: true }` or `{ recorded: false, existing }`.
 */
export async function recordSignatureWithRetry(ops, entry, message, {
  maxAttempts = RECORD_MAX_ATTEMPTS,
  backoff = defaultBackoff,
  sleep = sleepMs,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(backoff(attempt - 1));
      try {
        ops.sync();
      } catch (err) {
        lastErr = err;
        console.warn(`Attempt ${attempt}/${maxAttempts}: could not sync the ledger: ${err.message ?? err}`);
        continue;
      }
    }

    const current = ops.read();
    const existing = findSignature(current, entry.id);
    if (existing) {
      console.log(`@${entry.name} is already on the ledger (${existing.created_at}); not writing.`);
      return { recorded: false, existing };
    }
    ops.write(addSignature(current, entry).data);
    if (!ops.commit(message)) {
      // addSignature just added the entry, so an empty diff means the file on
      // disk already had it. Treat this like the already-recorded case.
      return { recorded: false, existing: null };
    }

    try {
      ops.push();
      return { recorded: true };
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${attempt}/${maxAttempts}: push rejected: ${err.message ?? err}`);
    }
  }
  throw new Error(
    `Failed to record signature for @${entry.name} after ${maxAttempts} attempts: ${lastErr?.message ?? lastErr}`,
  );
}

// Git-backed ops for recordSignatureWithRetry. Tests set `assertRemote: false`
// to point the ledger at a local bare repository. Production always checks.
export function createGitLedgerOps(dir = LEDGER_DIR, { branch = 'main', assertRemote = true } = {}) {
  let identityConfigured = false;
  return {
    sync: () => {
      git(['fetch', '--depth=1', 'origin', branch], { cwd: dir });
      // Drop this run's rejected commit. The caller re-applies the signature
      // to the fresh ledger.
      git(['reset', '--hard', 'FETCH_HEAD'], { cwd: dir });
    },
    read: () => readSignatures(dir),
    write: (data) => writeSignatures(data, dir),
    commit: (message) => {
      if (!git(['status', '--porcelain', SIGNATURES_PATH], { cwd: dir }).trim()) return false;
      if (assertRemote) assertLedgerRemote(dir);
      if (!identityConfigured) {
        configureGitIdentity(dir);
        identityConfigured = true;
      }
      git(['add', SIGNATURES_PATH], { cwd: dir });
      git(['commit', '-m', message], { cwd: dir });
      return true;
    },
    push: () => {
      if (assertRemote) assertLedgerRemote(dir);
      git(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir });
    },
  };
}

// Read the ledger at the current tip of origin/main rather than the checkout.
// The check-only job (pull_request_target) does not share a concurrency group
// with the signature-write job, so a signature can land on main after this
// job's checkout. Returns null when the fetch fails so callers fail closed
// (leave the status pending) instead of guessing.
function readLatestSignatures(dir, branch = 'main') {
  try {
    git(['fetch', '--depth=1', 'origin', branch], { cwd: dir });
    return parseSignatures(git(['show', `FETCH_HEAD:${SIGNATURES_PATH}`], { cwd: dir }));
  } catch (err) {
    console.warn(`Could not re-read ledger from origin/${branch}: ${err.message ?? err}`);
    return null;
  }
}

// The handlers reach the ledger only through this object so tests can drive
// them without a git checkout.
export function createGitLedger(dir = LEDGER_DIR, { assertRemote = true, retry } = {}) {
  const ops = createGitLedgerOps(dir, { assertRemote });
  return {
    read: () => readSignatures(dir),
    readLatest: () => readLatestSignatures(dir),
    record: (entry, message) => recordSignatureWithRetry(ops, entry, message, retry),
  };
}

async function setStatus(gh, eventRepo, sha, { state, description }) {
  if (!sha) return;
  await gh.createStatus(eventRepo.owner, eventRepo.repo, sha, {
    state,
    context: STATUS_CONTEXT,
    description,
  });
}

async function findExistingComment(gh, eventRepo, prNumber, marker) {
  for await (const c of gh.paginate(
    `/repos/${eventRepo.owner}/${eventRepo.repo}/issues/${prNumber}/comments`,
  )) {
    if (c.body && c.body.includes(marker)) return c;
  }
  return null;
}

async function ensureComment(gh, eventRepo, prNumber, marker, body) {
  const existing = await findExistingComment(gh, eventRepo, prNumber, marker);
  const fullBody = `${marker}\n${body}`;
  if (existing) {
    if (existing.body === fullBody) return existing;
    return gh.updateIssueComment(eventRepo.owner, eventRepo.repo, existing.id, fullBody);
  }
  return gh.createIssueComment(eventRepo.owner, eventRepo.repo, prNumber, fullBody);
}

function requestCommentBody(prAuthor) {
  return [
    '## IPR Policy Agreement Required',
    '',
    `@${prAuthor.login} — thanks for the contribution. Before this PR can be merged, the AgenticAdvertising.Org [IPR Policy](https://github.com/adcontextprotocol/adcp/blob/main/IPR_POLICY.md) requires your agreement.`,
    '',
    '**To agree**, post a new comment on this PR with the exact phrase:',
    '',
    '```',
    SIGN_PHRASE,
    '```',
    '',
    'Your signature is recorded once and covers all contributions to AAO repositories. See [`signatures/README.md`](https://github.com/adcontextprotocol/adcp/blob/main/signatures/README.md) for what gets recorded and why.',
  ].join('\n');
}

function confirmCommentBody(login) {
  return [
    '## IPR Policy — signed',
    '',
    `Thanks, @${login}. Your agreement to the [IPR Policy](https://github.com/adcontextprotocol/adcp/blob/main/IPR_POLICY.md) is recorded at [\`signatures/ipr-signatures.json\`](https://github.com/adcontextprotocol/adcp/blob/main/signatures/ipr-signatures.json) and applies to all AAO repositories.`,
  ].join('\n');
}

export async function handleIssueComment(gh, event, eventRepo, ledger = createGitLedger()) {
  const comment = event.comment;
  const issue = event.issue;
  if (!issue?.pull_request) {
    console.log('Comment is on an issue, not a PR — skipping.');
    return;
  }
  if (!isSignPhrase(comment.body)) {
    console.log('Comment body is not the sign phrase — skipping.');
    return;
  }
  if (isBot(comment.user)) {
    console.log(`Comment author ${comment.user?.login} is a bot — skipping.`);
    return;
  }
  if (!comment.user?.id) {
    console.log('Comment has no resolvable user (deleted account?) — skipping.');
    return;
  }

  const pr = await gh.getPullRequest(eventRepo.owner, eventRepo.repo, issue.number);
  const prAuthor = pr.user;
  const headSha = pr.head?.sha;

  if (!prAuthor?.id || prAuthor.id !== comment.user.id) {
    console.log(
      `Commenter ${comment.user.login} is not the PR author (${prAuthor?.login ?? '(none)'}) — ignoring signature attempt.`,
    );
    await ensureComment(
      gh,
      eventRepo,
      issue.number,
      WRONG_SIGNER_COMMENT_MARKER,
      `Only the PR author (@${prAuthor?.login ?? 'unknown'}) can sign the IPR Policy for this pull request. Thanks for the enthusiasm though, @${comment.user.login}.`,
    );
    return;
  }

  const signatures = ledger.read();
  if (hasSigned(signatures, prAuthor.id)) {
    const existing = findSignature(signatures, prAuthor.id);
    console.log(`${prAuthor.login} already signed on ${existing.created_at} — no-op.`);
    await setStatus(gh, eventRepo, headSha, {
      state: 'success',
      description: `@${prAuthor.login} signed on ${existing.created_at.slice(0, 10)}`,
    });
    return;
  }

  const entry = {
    name: prAuthor.login,
    id: prAuthor.id,
    created_at: comment.created_at,
    method: 'pr_comment',
    repo: `${eventRepo.owner}/${eventRepo.repo}`,
    pullRequestNo: issue.number,
    comment_id: comment.id,
    comment_url: comment.html_url,
  };
  // record() re-applies the entry to the remote head on each retry and skips
  // the write when a concurrent run already recorded this author.
  const { recorded } = await ledger.record(
    entry,
    `chore(ipr): record signature for @${prAuthor.login} (${eventRepo.owner}/${eventRepo.repo}#${issue.number})`,
  );
  if (!recorded) {
    console.log('Ledger already records this author at the remote head (concurrent write completed first).');
  }

  await ensureComment(gh, eventRepo, issue.number, CONFIRM_COMMENT_MARKER, confirmCommentBody(prAuthor.login));

  // A check job for a push that raced this signature may have read the ledger
  // before the push above landed and marked its head pending. Re-read the PR
  // head now that the signature is on main and mark it as well. Together with
  // the post-pending re-read in handlePullRequestTarget, every interleaving
  // ends with the latest head marked success.
  const shas = new Set([headSha]);
  try {
    const latest = await gh.getPullRequest(eventRepo.owner, eventRepo.repo, issue.number);
    if (latest?.head?.sha) shas.add(latest.head.sha);
  } catch (err) {
    console.warn(`Could not re-read PR head after recording: ${err.message ?? err}`);
  }
  for (const sha of shas) {
    await setStatus(gh, eventRepo, sha, {
      state: 'success',
      description: `@${prAuthor.login} signed just now`,
    });
  }
}

export async function handlePullRequestTarget(gh, event, eventRepo, ledger = createGitLedger()) {
  const pr = event.pull_request;
  if (!pr) {
    console.log('No pull_request payload — skipping.');
    return;
  }
  const prAuthor = pr.user;
  const headSha = pr.head?.sha;

  if (isBot(prAuthor)) {
    console.log(`PR author ${prAuthor?.login} is a bot — auto-pass.`);
    await setStatus(gh, eventRepo, headSha, {
      state: 'success',
      description: `Bot author (${prAuthor?.login}) — IPR Policy not applicable`,
    });
    return;
  }

  if (await setStatusIfSigned(gh, eventRepo, headSha, prAuthor, ledger.read())) return;

  await setStatus(gh, eventRepo, headSha, {
    state: 'pending',
    description: `Awaiting IPR Policy signature from @${prAuthor.login}`,
  });

  // This job runs outside the signature-write concurrency group, so the
  // checkout can predate a signature the author recorded while this job was
  // starting. Re-read origin/main *after* posting pending: a signature that
  // landed meanwhile overwrites the pending status here, and the write job
  // re-marks the latest head after its push to cover the opposite order.
  if (await setStatusIfSigned(gh, eventRepo, headSha, prAuthor, ledger.readLatest())) return;

  await ensureComment(gh, eventRepo, pr.number, CLAIM_COMMENT_MARKER, requestCommentBody(prAuthor));
}

async function setStatusIfSigned(gh, eventRepo, headSha, prAuthor, signatures) {
  if (!signatures || !hasSigned(signatures, prAuthor.id)) return false;
  const existing = findSignature(signatures, prAuthor.id);
  await setStatus(gh, eventRepo, headSha, {
    state: 'success',
    description: `@${prAuthor.login} signed on ${existing.created_at.slice(0, 10)}`,
  });
  return true;
}

async function main() {
  const gh = new GitHubClient();
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventRepo = parseRepoSlug(process.env.GITHUB_REPOSITORY ?? '');
  const event = loadEvent();

  switch (eventName) {
    case 'issue_comment':
      await handleIssueComment(gh, event, eventRepo);
      break;
    case 'pull_request_target':
      await handlePullRequestTarget(gh, event, eventRepo);
      break;
    default:
      console.log(`Ignoring event: ${eventName}`);
  }
}

// Run only when invoked as a script so tests can import the handlers. Compare
// real paths: Node resolves symlinks for the main module's import.meta.url but
// not for argv[1], and a false negative here would silently skip the status.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
