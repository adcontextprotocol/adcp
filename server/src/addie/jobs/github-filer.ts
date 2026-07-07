/**
 * GitHub issue filer.
 *
 * Thin wrapper around the GitHub REST API. Exposes a single seam so
 * callers can share one path and tests can mock cleanly.
 */

import { createLogger } from '../../logger.js';
import { redactSupportSecrets } from '../../services/support-redaction.js';
import { resolveGitHubToken } from './github-app-token.js';

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
 * Create a GitHub issue via resolveGitHubToken() (Secretariat App token
 * when configured, legacy PAT otherwise). Returns null on any failure
 * (missing credential, HTTP error, network error) so callers can keep
 * the escalation open without swallowing the exception.
 */
export async function fileGitHubIssue(input: FileIssueInput): Promise<FiledIssue | null> {
  const token = await resolveGitHubToken();
  if (!token) {
    logger.warn('No GitHub credential available; cannot file issue');
    return null;
  }

  const repo = input.repo ?? process.env.GITHUB_REPO ?? 'adcontextprotocol/adcp';

  // Bound the fetch so a GitHub outage can't hang the admin request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aao-escalation-triage/1.0',
      },
      body: JSON.stringify({
        title: redactSupportSecrets(input.title) ?? '',
        body: redactSupportSecrets(input.body) ?? '',
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
  } finally {
    clearTimeout(timer);
  }
}
