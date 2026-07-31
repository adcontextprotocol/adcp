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

export interface FileChange {
  /** Repo-relative file path to create or update. */
  path: string;
  content: string;
}

export interface UpsertFilesPrInput {
  /** Repo slug `owner/name`. Defaults to `GITHUB_REPO` env or `adcontextprotocol/adcp`. */
  repo?: string;
  /** Head branch the PR ships from, e.g. `addie/secretariat-1234`. */
  branch: string;
  /** Base branch. Defaults to `main`. */
  baseBranch?: string;
  files: FileChange[];
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
 * Ensure `branch` exists at `base`'s current head, force-resetting it if
 * it already exists so stale content never leaks into the diff. Returns
 * the base sha on success, null on any failure.
 */
async function resetBranchToBase(
  token: string,
  api: string,
  branch: string,
  base: string,
  repo: string
): Promise<string | null> {
  const refResp = await ghFetch(token, `${api}/git/ref/heads/${base}`);
  if (!refResp.ok) {
    logger.error({ status: refResp.status, repo, base }, 'Base ref lookup failed');
    return null;
  }
  const baseSha = ((await refResp.json()) as { object: { sha: string } }).object.sha;

  const createResp = await ghFetch(token, `${api}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!createResp.ok) {
    if (createResp.status !== 422) {
      logger.error({ status: createResp.status, repo }, 'Branch create failed');
      return null;
    }
    const resetResp = await ghFetch(token, `${api}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: baseSha, force: true }),
    });
    if (!resetResp.ok) {
      logger.error({ status: resetResp.status, repo }, 'Branch reset failed');
      return null;
    }
  }
  return baseSha;
}

/**
 * PUT a single file's content onto `branch` via the Contents API,
 * looking up the existing blob sha first (absent on a first-ever write).
 * Returns true on success.
 */
async function putFileContent(
  token: string,
  api: string,
  branch: string,
  file: FileChange,
  commitMessage: string,
  repo: string
): Promise<boolean> {
  const fileResp = await ghFetch(
    token,
    `${api}/contents/${file.path}?ref=${encodeURIComponent(branch)}`
  );
  let existingSha: string | undefined;
  if (fileResp.ok) {
    existingSha = ((await fileResp.json()) as { sha?: string }).sha;
  } else if (fileResp.status !== 404) {
    logger.error({ status: fileResp.status, repo, path: file.path }, 'File lookup failed');
    return false;
  }

  const putResp = await ghFetch(token, `${api}/contents/${file.path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  if (!putResp.ok) {
    const err = await putResp.text().catch(() => '');
    logger.error({ status: putResp.status, err, repo, path: file.path }, 'File commit failed');
    return false;
  }
  return true;
}

/**
 * Reuse the open PR for `branch` if one exists, or open a new one.
 */
async function reuseOrOpenPr(
  token: string,
  api: string,
  repo: string,
  branch: string,
  base: string,
  prTitle: string,
  prBody: string
): Promise<UpsertFilePrResult | null> {
  const owner = repo.split('/')[0];
  const listResp = await ghFetch(
    token,
    `${api}/pulls?head=${owner}:${encodeURIComponent(branch)}&base=${base}&state=open`
  );
  if (listResp.ok) {
    const open = (await listResp.json()) as Array<{ html_url: string; number: number }>;
    if (open.length > 0) {
      return { prUrl: open[0].html_url, prNumber: open[0].number, created: false };
    }
  }

  const prResp = await ghFetch(token, `${api}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: prTitle, head: branch, base, body: prBody }),
  });
  if (!prResp.ok) {
    const err = await prResp.text().catch(() => '');
    logger.error({ status: prResp.status, err, repo }, 'PR create failed');
    return null;
  }
  const pr = (await prResp.json()) as { html_url: string; number: number };
  return { prUrl: pr.html_url, prNumber: pr.number, created: true };
}

/**
 * Create or refresh a single-file PR. Returns null on any failure so
 * job callers can record the miss without throwing.
 */
export async function upsertFilePr(input: UpsertFilePrInput): Promise<UpsertFilePrResult | null> {
  return upsertFilesPr({
    repo: input.repo,
    branch: input.branch,
    baseBranch: input.baseBranch,
    files: [{ path: input.path, content: input.content }],
    commitMessage: input.commitMessage,
    prTitle: input.prTitle,
    prBody: input.prBody,
  });
}

/**
 * Create or refresh a multi-file PR: force-resets the working branch to
 * base head, PUTs each file's content, then reuses or opens the PR.
 * Returns null on any failure so job callers can record the miss without
 * throwing.
 */
export async function upsertFilesPr(input: UpsertFilesPrInput): Promise<UpsertFilePrResult | null> {
  const token = await resolveGitHubToken();
  if (!token) {
    logger.warn('No GitHub credential available; cannot open PR');
    return null;
  }
  const repo = input.repo ?? process.env.GITHUB_REPO ?? 'adcontextprotocol/adcp';
  const base = input.baseBranch ?? 'main';
  const api = `https://api.github.com/repos/${repo}`;

  try {
    const baseSha = await resetBranchToBase(token, api, input.branch, base, repo);
    if (!baseSha) return null;

    for (const file of input.files) {
      const ok = await putFileContent(token, api, input.branch, file, input.commitMessage, repo);
      if (!ok) return null;
    }

    return await reuseOrOpenPr(token, api, repo, input.branch, base, input.prTitle, input.prBody);
  } catch (err) {
    logger.error({ err, repo }, 'upsertFilesPr threw');
    return null;
  }
}
