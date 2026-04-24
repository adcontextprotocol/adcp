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
 *   GITHUB_TOKEN         — auth, contents:write + pull-requests:write + statuses:write
 *   GITHUB_EVENT_NAME    — "issue_comment" | "pull_request_target"
 *   GITHUB_EVENT_PATH    — path to the event JSON
 *   GITHUB_REPOSITORY    — "owner/repo"
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GitHubClient } from './github.mjs';
import {
  SIGN_PHRASE,
  addSignature,
  findSignature,
  hasSigned,
  isSignPhrase,
  readSignatures,
  writeSignatures,
} from './signatures.mjs';

const STATUS_CONTEXT = 'IPR Policy / Signature';
const CLAIM_COMMENT_MARKER = '<!-- ipr-check:request -->';
const CONFIRM_COMMENT_MARKER = '<!-- ipr-check:confirmed -->';
const WRONG_SIGNER_COMMENT_MARKER = '<!-- ipr-check:wrong-signer -->';

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

function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

function gitStatusPorcelain(pathname) {
  return execFileSync('git', ['status', '--porcelain', pathname], { encoding: 'utf8' }).trim();
}

function configureGitIdentity() {
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
}

function commitSignaturesChange(message, branch = 'main') {
  if (!gitStatusPorcelain('signatures/ipr-signatures.json')) return false;
  git(['add', 'signatures/ipr-signatures.json']);
  git(['commit', '-m', message]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      git(['push', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'inherit' });
      return true;
    } catch (pushErr) {
      if (attempt === 2) throw pushErr;
      // Rebase onto a newer main and retry. Rebase failures are not recoverable
      // here (conflict on an append-only JSON means something upstream wrote an
      // incompatible shape) — rethrow immediately.
      git(['pull', '--rebase', 'origin', branch], { stdio: 'inherit' });
    }
  }
  throw new Error('Failed to push signature update after retries');
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

async function handleIssueComment(gh, event, eventRepo) {
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

  const signatures = readSignatures();
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
  const { data: next, added } = addSignature(signatures, entry);
  if (!added) {
    throw new Error(`Unexpected: ${prAuthor.login} already signed after hasSigned check`);
  }
  writeSignatures(next);

  configureGitIdentity();
  const committed = commitSignaturesChange(
    `chore(ipr): record signature for @${prAuthor.login} (${eventRepo.owner}/${eventRepo.repo}#${issue.number})`,
  );
  if (!committed) {
    console.log('Ledger already up to date at HEAD (concurrent write completed first).');
  }

  await ensureComment(gh, eventRepo, issue.number, CONFIRM_COMMENT_MARKER, confirmCommentBody(prAuthor.login));
  await setStatus(gh, eventRepo, headSha, {
    state: 'success',
    description: `@${prAuthor.login} signed just now`,
  });
}

async function handlePullRequestTarget(gh, event, eventRepo) {
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

  const signatures = readSignatures();
  if (hasSigned(signatures, prAuthor.id)) {
    const existing = findSignature(signatures, prAuthor.id);
    await setStatus(gh, eventRepo, headSha, {
      state: 'success',
      description: `@${prAuthor.login} signed on ${existing.created_at.slice(0, 10)}`,
    });
    return;
  }

  await setStatus(gh, eventRepo, headSha, {
    state: 'pending',
    description: `Awaiting IPR Policy signature from @${prAuthor.login}`,
  });
  await ensureComment(gh, eventRepo, pr.number, CLAIM_COMMENT_MARKER, requestCommentBody(prAuthor));
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

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
