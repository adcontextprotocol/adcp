/**
 * Secretariat PR shepherd — proposer job v1.
 *
 * Sweeps open PRs on `adcontextprotocol/adcp` for ones whose
 * `IPR Policy / Signature` commit status (set by
 * `scripts/ipr/check-and-record.mjs`) is still `pending` after the PR has
 * been open a while. The IPR bot only comments once, at PR-open time; this
 * job is the backstop for authors who missed that comment or forgot to
 * follow up.
 *
 * This job only PROPOSES a `post_issue_comment` action — a human approves
 * it in the Secretariat console before anything posts to GitHub. Detection
 * is resilient by design: any failure to read a PR's status is treated as
 * "skip this PR," never as a job failure.
 */

import { createLogger } from '../../logger.js';
import { resolveGitHubToken } from './github-app-token.js';
import * as secretariatDb from '../../db/secretariat-actions-db.js';

const logger = createLogger('secretariat-pr-shepherd');

const STATUS_CONTEXT = 'IPR Policy / Signature';
const DEFAULT_REPO = 'adcontextprotocol/adcp';
const API_TIMEOUT_MS = 10_000;

export interface PrShepherdOptions {
  repo?: string;
  /** PR age (days) after which a pending IPR check earns a nudge. Default 7. */
  minAgeDays?: number;
}

export interface PrShepherdResult {
  prsScanned: number;
  proposed: number;
  skippedNotPending: number;
  skippedTooNew: number;
  skippedLookupFailed: number;
}

interface GhPullRequest {
  number: number;
  created_at: string;
  user: { login: string } | null;
  head: { sha: string };
}

interface GhCombinedStatus {
  statuses?: Array<{ context: string; state: string }>;
}

async function ghFetch(token: string, url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aao-secretariat/1.0',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function ageInDays(createdAt: string): number {
  return (Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * True when the PR's combined commit status carries a pending
 * `IPR Policy / Signature` entry. Returns null (not false) when the
 * lookup itself fails, so the caller can tell "checked, not pending"
 * apart from "couldn't check."
 */
async function isIprSignaturePending(
  token: string,
  repo: string,
  sha: string,
  prNumber: number
): Promise<boolean | null> {
  try {
    const resp = await ghFetch(token, `https://api.github.com/repos/${repo}/commits/${sha}/status`);
    if (!resp.ok) {
      logger.debug({ status: resp.status, repo, pr: prNumber }, 'PR shepherd: status lookup failed; skipping PR');
      return null;
    }
    const combined = (await resp.json()) as GhCombinedStatus;
    const iprStatus = combined.statuses?.find((s) => s.context === STATUS_CONTEXT);
    return iprStatus?.state === 'pending';
  } catch (err) {
    logger.debug({ err, repo, pr: prNumber }, 'PR shepherd: status lookup threw; skipping PR');
    return null;
  }
}

export async function runSecretariatPrShepherdJob(
  options: PrShepherdOptions = {}
): Promise<PrShepherdResult> {
  const repo = options.repo ?? DEFAULT_REPO;
  const minAgeDays = options.minAgeDays ?? 7;

  const result: PrShepherdResult = {
    prsScanned: 0,
    proposed: 0,
    skippedNotPending: 0,
    skippedTooNew: 0,
    skippedLookupFailed: 0,
  };

  const token = await resolveGitHubToken();
  if (!token) {
    logger.warn('No GitHub credential available; skipping PR shepherd sweep');
    return result;
  }

  let pulls: GhPullRequest[];
  try {
    // MVP: single page (100 open PRs). Revisit with pagination if adcp
    // ever carries more open PRs than that at once.
    const resp = await ghFetch(token, `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`);
    if (!resp.ok) {
      logger.warn({ status: resp.status, repo }, 'PR shepherd: PR list lookup failed');
      return result;
    }
    pulls = (await resp.json()) as GhPullRequest[];
  } catch (err) {
    logger.warn({ err, repo }, 'PR shepherd: PR list lookup threw');
    return result;
  }
  result.prsScanned = pulls.length;

  for (const pr of pulls) {
    if (ageInDays(pr.created_at) < minAgeDays) {
      result.skippedTooNew++;
      continue;
    }

    const pending = await isIprSignaturePending(token, repo, pr.head.sha, pr.number);
    if (pending === null) {
      result.skippedLookupFailed++;
      continue;
    }
    if (!pending) {
      result.skippedNotPending++;
      continue;
    }

    const author = pr.user?.login ?? 'there';
    const ageDays = Math.floor(ageInDays(pr.created_at));
    const prUrl = `https://github.com/${repo}/pull/${pr.number}`;

    await secretariatDb.propose({
      kind: 'post_issue_comment',
      title: `Nudge PR #${pr.number} for IPR signature (${ageDays}d open)`,
      rationale:
        `[PR #${pr.number}](${prUrl}) on \`${repo}\` has been open ${ageDays} days and its ` +
        `\`${STATUS_CONTEXT}\` commit status is still pending. The IPR bot only comments once, ` +
        `at PR-open time — this is a one-time follow-up nudge.`,
      payload: {
        repo,
        issueNumber: pr.number,
        body:
          `Hi @${author} — friendly nudge: this PR is still waiting on the IPR Policy signature. ` +
          `Whenever you have a moment, comment with the phrase "I have read the IPR Policy" ` +
          `(see [IPR_POLICY.md](https://github.com/${repo}/blob/main/IPR_POLICY.md)) so this can ` +
          `move forward once everything else is ready.`,
      },
      origin: 'secretariat-pr-shepherd',
      dedupe_key: `ipr-nudge:${pr.number}`,
    });
    result.proposed++;
  }

  return result;
}
