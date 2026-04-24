/**
 * GitHub issue filer for escalation triage.
 *
 * Thin wrapper around the GitHub REST API used by the "file as issue"
 * accept flow. Same pattern as knowledge-gap-closer's inline filer —
 * factored out so callers across Addie jobs can share one path and so
 * tests can mock a single seam.
 */

import { createLogger } from '../../logger.js';

const logger = createLogger('github-filer');

export interface FileIssueInput {
  title: string;
  body: string;
  /** Repo slug `owner/name`. Defaults to `GITHUB_REPO` env or `adcontextprotocol/adcp`. */
  repo?: string;
  labels?: string[];
}

export interface FiledIssue {
  url: string;
  number: number;
  repo: string;
}

/**
 * Create a GitHub issue using the GITHUB_TOKEN env var. Returns null on
 * any failure (missing token, HTTP error, network error) so callers can
 * keep the escalation open without swallowing the exception.
 */
export async function fileGitHubIssue(input: FileIssueInput): Promise<FiledIssue | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logger.warn('GITHUB_TOKEN not set; cannot file issue');
    return null;
  }

  const repo = input.repo ?? process.env.GITHUB_REPO ?? 'adcontextprotocol/adcp';

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aao-escalation-triage/1.0',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        labels: input.labels ?? [],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      logger.error({ status: resp.status, err, repo }, 'GitHub issue create failed');
      return null;
    }

    const issue = (await resp.json()) as { html_url: string; number: number };
    return { url: issue.html_url, number: issue.number, repo };
  } catch (err) {
    logger.error({ err, repo }, 'GitHub issue create threw');
    return null;
  }
}
