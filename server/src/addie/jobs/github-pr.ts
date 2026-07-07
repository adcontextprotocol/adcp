/**
 * GitHub single-file PR helper.
 *
 * Creates or refreshes a one-file pull request via the GitHub REST API,
 * authenticated through resolveGitHubToken() (Secretariat App token when
 * configured, legacy PAT otherwise). The working branch is force-reset
 * to the base branch head on every call, so the PR diff is always
 * exactly "base + this file change".
 */

import { createLogger } from '../../logger.js';
import { resolveGitHubToken } from './github-app-token.js';

const logger = createLogger('github-pr');

const API_TIMEOUT_MS = 10_000;

export interface UpsertFilePrInput {
  /** Repo slug `owner/name`. Defaults to `GITHUB_REPO` env or `adcontextprotocol/adcp`. */
  repo?: string;
  /** Head branch the PR ships from, e.g. `addie/wg-slack-context`. */
  branch: string;
  /** Base branch. Defaults to `main`. */
  baseBranch?: string;
  /** Repo-relative file path to create or update. */
  path: string;
  content: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface UpsertFilePrResult {
  prUrl: string;
  prNumber: number;
  /** True when a new PR was opened; false when an open PR was refreshed. */
  created: boolean;
}

async function ghFetch(token: string, url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'aao-wg-secretary/1.0',
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the current content of a file at a ref. Returns null when the
 * file does not exist or the token is missing; throws on other failures
 * so callers can distinguish "absent" from "unreadable".
 */
export async function getFileContent(
  path: string,
  ref: string,
  repo?: string
): Promise<string | null> {
  const token = await resolveGitHubToken();
  if (!token) return null;
  const repoSlug = repo ?? process.env.GITHUB_REPO ?? 'adcontextprotocol/adcp';
  const resp = await ghFetch(
    token,
    `https://api.github.com/repos/${repoSlug}/contents/${path}?ref=${encodeURIComponent(ref)}`
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`GitHub contents read failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { content?: string };
  if (!data.content) return null;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

/**
 * Create or refresh a single-file PR. Returns null on any failure so
 * job callers can record the miss without throwing.
 */
export async function upsertFilePr(input: UpsertFilePrInput): Promise<UpsertFilePrResult | null> {
  const token = await resolveGitHubToken();
  if (!token) {
    logger.warn('No GitHub credential available; cannot open PR');
    return null;
  }
  const repo = input.repo ?? process.env.GITHUB_REPO ?? 'adcontextprotocol/adcp';
  const base = input.baseBranch ?? 'main';
  const api = `https://api.github.com/repos/${repo}`;

  try {
    const refResp = await ghFetch(token, `${api}/git/ref/heads/${base}`);
    if (!refResp.ok) {
      logger.error({ status: refResp.status, repo, base }, 'Base ref lookup failed');
      return null;
    }
    const baseSha = ((await refResp.json()) as { object: { sha: string } }).object.sha;

    // Ensure the working branch exists at base head. Force-reset an
    // existing branch so stale content never leaks into the diff.
    const createResp = await ghFetch(token, `${api}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: baseSha }),
    });
    if (!createResp.ok) {
      if (createResp.status !== 422) {
        logger.error({ status: createResp.status, repo }, 'Branch create failed');
        return null;
      }
      const resetResp = await ghFetch(token, `${api}/git/refs/heads/${input.branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: baseSha, force: true }),
      });
      if (!resetResp.ok) {
        logger.error({ status: resetResp.status, repo }, 'Branch reset failed');
        return null;
      }
    }

    // Blob sha of the file on the branch (equals base's copy after the
    // reset); absent for a first-ever refresh.
    const fileResp = await ghFetch(
      token,
      `${api}/contents/${input.path}?ref=${encodeURIComponent(input.branch)}`
    );
    let existingSha: string | undefined;
    if (fileResp.ok) {
      existingSha = ((await fileResp.json()) as { sha?: string }).sha;
    } else if (fileResp.status !== 404) {
      logger.error({ status: fileResp.status, repo }, 'File lookup failed');
      return null;
    }

    const putResp = await ghFetch(token, `${api}/contents/${input.path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: input.commitMessage,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        branch: input.branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!putResp.ok) {
      const err = await putResp.text().catch(() => '');
      logger.error({ status: putResp.status, err, repo }, 'File commit failed');
      return null;
    }

    // Reuse the open PR for this branch, or open one.
    const owner = repo.split('/')[0];
    const listResp = await ghFetch(
      token,
      `${api}/pulls?head=${owner}:${encodeURIComponent(input.branch)}&base=${base}&state=open`
    );
    if (listResp.ok) {
      const open = (await listResp.json()) as Array<{ html_url: string; number: number }>;
      if (open.length > 0) {
        return { prUrl: open[0].html_url, prNumber: open[0].number, created: false };
      }
    }

    const prResp = await ghFetch(token, `${api}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.prTitle,
        head: input.branch,
        base,
        body: input.prBody,
      }),
    });
    if (!prResp.ok) {
      const err = await prResp.text().catch(() => '');
      logger.error({ status: prResp.status, err, repo }, 'PR create failed');
      return null;
    }
    const pr = (await prResp.json()) as { html_url: string; number: number };
    return { prUrl: pr.html_url, prNumber: pr.number, created: true };
  } catch (err) {
    logger.error({ err, repo }, 'upsertFilePr threw');
    return null;
  }
}
