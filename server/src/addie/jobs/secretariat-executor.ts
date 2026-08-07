/**
 * Secretariat action executor.
 *
 * Claims `approved` rows from `secretariat_actions` one at a time and
 * executes them. Nothing in this file ever approves an action — approval
 * happens only via a human clicking Approve in the Secretariat console
 * (`server/src/routes/secretariat-admin.ts`). This file's only job is to
 * carry out a decision a human already made.
 *
 * HARD SAFETY RULES:
 * 1. `ALLOWED_KINDS` is the single allowlist of action kinds this executor
 *    will ever run. An unrecognized kind fails closed (markFailed), never
 *    silently executes.
 * 2. This executor must NEVER call a PR-merge, PR-review, or PR-approve
 *    endpoint. Adding such a capability here would let an automated loop
 *    close the human-approval loop it exists to enforce.
 * 3. Every kind's payload is validated before use; a malformed payload
 *    fails the action (markFailed) rather than throwing past the caller.
 */

import { createLogger } from '../../logger.js';
import * as secretariatDb from '../../db/secretariat-actions-db.js';
import type { SecretariatAction } from '../../db/secretariat-actions-db.js';
import { upsertFilesPr, type FileChange } from './github-pr.js';
import { fileGitHubIssue, postIssueComment } from './github-filer.js';
import { sendChannelMessage } from '../../slack/client.js';

const logger = createLogger('secretariat-executor');

/**
 * The only action kinds the executor will run. Also the source of truth
 * for the manual-enqueue admin route's kind validation.
 */
export const ALLOWED_KINDS = ['open_pr', 'post_issue_comment', 'file_issue', 'post_slack_message'] as const;
export type AllowedKind = (typeof ALLOWED_KINDS)[number];

export interface OpenPrPayload {
  repo?: string;
  branch: string;
  baseBranch?: string;
  files: FileChange[];
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface PostIssueCommentPayload {
  repo?: string;
  issueNumber: number;
  body: string;
}

export interface FileIssuePayload {
  repo?: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface PostSlackMessagePayload {
  channelId: string;
  text: string;
}

export interface SecretariatExecutorOptions {
  /** Max approved actions to claim and process per tick. Default 10. */
  limit?: number;
}

export interface SecretariatExecutorResult {
  /** Approved actions successfully claimed this tick. */
  claimed: number;
  executed: number;
  failed: number;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string when present`);
  return value;
}

function validateOpenPr(payload: Record<string, unknown>): OpenPrPayload {
  const branch = requireString(payload, 'branch');
  const commitMessage = requireString(payload, 'commitMessage');
  const prTitle = requireString(payload, 'prTitle');
  const prBody = requireString(payload, 'prBody');
  const repo = optionalString(payload, 'repo');
  const baseBranch = optionalString(payload, 'baseBranch');

  const rawFiles = payload.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('files must be a non-empty array');
  }
  const files: FileChange[] = rawFiles.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`files[${i}] must be an object`);
    const path = (f as Record<string, unknown>).path;
    const content = (f as Record<string, unknown>).content;
    if (typeof path !== 'string' || path.length === 0) throw new Error(`files[${i}].path must be a non-empty string`);
    if (typeof content !== 'string') throw new Error(`files[${i}].content must be a string`);
    return { path, content };
  });

  return { repo, branch, baseBranch, files, commitMessage, prTitle, prBody };
}

function validatePostIssueComment(payload: Record<string, unknown>): PostIssueCommentPayload {
  const issueNumber = payload.issueNumber;
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('issueNumber must be a positive integer');
  }
  const body = requireString(payload, 'body');
  const repo = optionalString(payload, 'repo');
  return { repo, issueNumber, body };
}

function validateFileIssue(payload: Record<string, unknown>): FileIssuePayload {
  const title = requireString(payload, 'title');
  const body = requireString(payload, 'body');
  const repo = optionalString(payload, 'repo');
  const rawLabels = payload.labels;
  let labels: string[] | undefined;
  if (rawLabels !== undefined) {
    if (!Array.isArray(rawLabels) || !rawLabels.every((l) => typeof l === 'string')) {
      throw new Error('labels must be an array of strings when present');
    }
    labels = rawLabels;
  }
  return { repo, title, body, labels };
}

function validatePostSlackMessage(payload: Record<string, unknown>): PostSlackMessagePayload {
  const channelId = requireString(payload, 'channelId');
  const text = requireString(payload, 'text');
  return { channelId, text };
}

async function executeOpenPr(payload: OpenPrPayload): Promise<Record<string, unknown>> {
  const pr = await upsertFilesPr({
    repo: payload.repo,
    branch: payload.branch,
    baseBranch: payload.baseBranch,
    files: payload.files,
    commitMessage: payload.commitMessage,
    prTitle: payload.prTitle,
    prBody: payload.prBody,
  });
  if (!pr) throw new Error('upsertFilesPr failed (see logs for the failing GitHub call)');
  return { prUrl: pr.prUrl, prNumber: pr.prNumber, created: pr.created };
}

async function executePostIssueComment(payload: PostIssueCommentPayload): Promise<Record<string, unknown>> {
  const comment = await postIssueComment({
    repo: payload.repo,
    issueNumber: payload.issueNumber,
    body: payload.body,
  });
  if (!comment) throw new Error('postIssueComment failed (see logs for the failing GitHub call)');
  return { commentUrl: comment.url, commentId: comment.id };
}

async function executeFileIssue(payload: FileIssuePayload): Promise<Record<string, unknown>> {
  const issue = await fileGitHubIssue({
    repo: payload.repo,
    title: payload.title,
    body: payload.body,
    labels: payload.labels,
  });
  if (!issue) throw new Error('fileGitHubIssue failed (see logs for the failing GitHub call)');
  return { issueUrl: issue.url, issueNumber: issue.number };
}

async function executePostSlackMessage(payload: PostSlackMessagePayload): Promise<Record<string, unknown>> {
  const sent = await sendChannelMessage(payload.channelId, { text: payload.text });
  if (!sent.ok) throw new Error(`sendChannelMessage failed: ${sent.error ?? 'unknown error'}`);
  return { slackTs: sent.ts ?? null };
}

/**
 * Dispatch a claimed action to its executor seam. The `default` branch
 * is the fail-closed path for kinds outside `ALLOWED_KINDS` — including
 * any kind that might reach here from a data path that skipped the
 * admin route's allowlist check.
 */
async function dispatch(kind: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'open_pr':
      return executeOpenPr(validateOpenPr(payload));
    case 'post_issue_comment':
      return executePostIssueComment(validatePostIssueComment(payload));
    case 'file_issue':
      return executeFileIssue(validateFileIssue(payload));
    case 'post_slack_message':
      return executePostSlackMessage(validatePostSlackMessage(payload));
    default:
      throw new Error(`Unknown or disallowed action kind: ${kind}`);
  }
}

/**
 * Process up to `options.limit` approved actions: claim, execute,
 * mark done or failed. Runs on a short interval (see job-definitions.ts)
 * so an approval in the console is picked up within a couple of minutes.
 */
export async function runSecretariatExecutorJob(
  options: SecretariatExecutorOptions = {}
): Promise<SecretariatExecutorResult> {
  const limit = options.limit ?? 10;
  const result: SecretariatExecutorResult = { claimed: 0, executed: 0, failed: 0 };

  const approved = await secretariatDb.listByStatus({ status: 'approved', limit });

  for (const action of approved) {
    const claimed: SecretariatAction | null = await secretariatDb.claimForExecution(action.id);
    if (!claimed) {
      // Another executor tick (or a concurrent instance) already claimed
      // this row. Skip — no double execution.
      logger.debug({ id: action.id }, 'Secretariat action already claimed; skipping');
      continue;
    }
    result.claimed++;

    try {
      const output = await dispatch(claimed.kind, claimed.payload);
      await secretariatDb.markDone(claimed.id, output);
      result.executed++;
      logger.info({ id: claimed.id, kind: claimed.kind, output }, 'Secretariat action executed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await secretariatDb.markFailed(claimed.id, message);
      result.failed++;
      logger.error({ err, id: claimed.id, kind: claimed.kind }, 'Secretariat action failed');
    }
  }

  return result;
}
