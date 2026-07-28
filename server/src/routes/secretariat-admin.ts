/**
 * Secretariat console admin routes.
 *
 * Human-approved action queue for the AAO Secretariat: proposer jobs write
 * `secretariat_actions` rows, admins review/edit/approve/reject them here,
 * and the executor job (server/src/addie/jobs/secretariat-executor.ts)
 * carries out approved actions. Nothing executes without a human clicking
 * Approve — see the executor's hard safety rules.
 */

import { Router } from "express";
import { validate as uuidValidate } from "uuid";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import * as secretariatDb from "../db/secretariat-actions-db.js";
import type { SecretariatActionStatus } from "../db/secretariat-actions-db.js";
import { ALLOWED_KINDS } from "../addie/jobs/secretariat-executor.js";
import { resolveGitHubToken } from "../addie/jobs/github-app-token.js";

const logger = createLogger("secretariat-admin-routes");

const VALID_STATUSES: SecretariatActionStatus[] = [
  'proposed', 'approved', 'rejected', 'executing', 'done', 'failed',
];

const DEFAULT_REPO = 'adcontextprotocol/adcp';
const NEEDS_WG_REVIEW_LABEL = 'needs-wg-review';
const WATCHING_CACHE_TTL_MS = 5 * 60_000;
const API_TIMEOUT_MS = 10_000;

function isValidUuid(id: string): boolean {
  return uuidValidate(id);
}

/** Who made this decision, for the audit trail. */
function resolveDecider(req: { user?: { email?: string } }): string {
  return req.user?.email ?? 'unknown-admin';
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

interface GhPullRequest {
  number: number;
  title: string;
  user: { login: string } | null;
  created_at: string;
  draft?: boolean;
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
  html_url: string;
}

interface GhIssue {
  number: number;
  created_at: string;
  pull_request?: unknown;
}

export interface WatchingPr {
  number: number;
  title: string;
  author: string;
  ageDays: number;
  reviewState: 'draft' | 'awaiting_reviewers' | 'no_reviewers_requested';
  url: string;
}

export interface WatchingSnapshot {
  openPrs: WatchingPr[];
  needsWgReview: {
    count: number;
    ageBuckets: { under7d: number; d7to14: number; over14d: number };
  };
  fetchedAt: string;
}

function ageInDays(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
}

async function buildWatchingSnapshot(repo: string): Promise<WatchingSnapshot | null> {
  const token = await resolveGitHubToken();
  if (!token) {
    logger.warn('No GitHub credential available; cannot build watching snapshot');
    return null;
  }

  const [prsResp, issuesResp] = await Promise.all([
    ghFetch(token, `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`),
    ghFetch(
      token,
      `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(NEEDS_WG_REVIEW_LABEL)}&per_page=100`
    ),
  ]);

  if (!prsResp.ok || !issuesResp.ok) {
    logger.warn({ prsStatus: prsResp.status, issuesStatus: issuesResp.status, repo }, 'Watching snapshot: GitHub lookup failed');
    return null;
  }

  const pulls = (await prsResp.json()) as GhPullRequest[];
  const issues = (await issuesResp.json()) as GhIssue[];

  const openPrs: WatchingPr[] = pulls.map((pr) => {
    let reviewState: WatchingPr['reviewState'] = 'no_reviewers_requested';
    if (pr.draft) reviewState = 'draft';
    else if ((pr.requested_reviewers?.length ?? 0) > 0 || (pr.requested_teams?.length ?? 0) > 0) {
      reviewState = 'awaiting_reviewers';
    }
    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? 'unknown',
      ageDays: ageInDays(pr.created_at),
      reviewState,
      url: pr.html_url,
    };
  });

  // The issues endpoint returns PRs too; exclude them from the WG-review queue.
  const wgReviewIssues = issues.filter((i) => !i.pull_request);
  const ageBuckets = { under7d: 0, d7to14: 0, over14d: 0 };
  for (const issue of wgReviewIssues) {
    const age = ageInDays(issue.created_at);
    if (age < 7) ageBuckets.under7d++;
    else if (age <= 14) ageBuckets.d7to14++;
    else ageBuckets.over14d++;
  }

  return {
    openPrs,
    needsWgReview: { count: wgReviewIssues.length, ageBuckets },
    fetchedAt: new Date().toISOString(),
  };
}

let watchingCache: { snapshot: WatchingSnapshot; expiresAtMs: number } | null = null;

async function getWatchingSnapshot(repo: string): Promise<WatchingSnapshot | null> {
  if (watchingCache && watchingCache.expiresAtMs > Date.now()) {
    return watchingCache.snapshot;
  }
  const snapshot = await buildWatchingSnapshot(repo);
  if (snapshot) {
    watchingCache = { snapshot, expiresAtMs: Date.now() + WATCHING_CACHE_TTL_MS };
  }
  return snapshot;
}

export function createSecretariatAdminRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // PAGE ROUTES (mounted at /admin/secretariat)
  // =========================================================================

  pageRouter.get("/", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "secretariat.html").catch((err) => {
      logger.error({ err }, "Error serving Secretariat admin page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // ACTIONS API (mounted at /api/admin/secretariat)
  // =========================================================================

  // GET /api/admin/secretariat/actions?status=proposed
  apiRouter.get("/actions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status } = req.query;
      let validatedStatus: SecretariatActionStatus | undefined;
      if (typeof status === 'string' && status.length > 0) {
        if (!VALID_STATUSES.includes(status as SecretariatActionStatus)) {
          return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
        }
        validatedStatus = status as SecretariatActionStatus;
      }

      const actions = await secretariatDb.listByStatus({ status: validatedStatus, limit: 200 });
      res.json({ actions, total: actions.length });
    } catch (error) {
      logger.error({ err: error }, "Error listing Secretariat actions");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/secretariat/watching
  // NOTE: defined before /actions/:id-shaped routes don't collide since path differs.
  apiRouter.get("/watching", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const snapshot = await getWatchingSnapshot(DEFAULT_REPO);
      if (!snapshot) {
        return res.status(502).json({ error: "GitHub lookup unavailable" });
      }
      res.json(snapshot);
    } catch (error) {
      logger.error({ err: error }, "Error building watching snapshot");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/secretariat/stats
  apiRouter.get("/stats", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const stats = await secretariatDb.getStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching Secretariat stats");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/secretariat/actions - manual enqueue/seed
  apiRouter.post("/actions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { kind, title, rationale, payload, dedupe_key } = req.body;

      if (typeof kind !== 'string' || !ALLOWED_KINDS.includes(kind as (typeof ALLOWED_KINDS)[number])) {
        return res.status(400).json({ error: `kind must be one of: ${ALLOWED_KINDS.join(', ')}` });
      }
      if (typeof title !== 'string' || title.length === 0) {
        return res.status(400).json({ error: "title is required" });
      }
      if (typeof rationale !== 'string' || rationale.length === 0) {
        return res.status(400).json({ error: "rationale is required" });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: "payload must be an object" });
      }
      if (dedupe_key !== undefined && typeof dedupe_key !== 'string') {
        return res.status(400).json({ error: "dedupe_key must be a string when present" });
      }

      const action = await secretariatDb.propose({
        kind,
        title,
        rationale,
        payload,
        origin: `manual:${resolveDecider(req)}`,
        dedupe_key: dedupe_key ?? null,
      });

      logger.info({ id: action.id, kind }, "Manually enqueued Secretariat action");
      res.status(201).json(action);
    } catch (error) {
      logger.error({ err: error }, "Error enqueuing Secretariat action");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/secretariat/actions/:id
  apiRouter.get("/actions/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidUuid(id)) return res.status(400).json({ error: "Invalid action id" });

      const action = await secretariatDb.get(id);
      if (!action) return res.status(404).json({ error: "Action not found" });
      res.json(action);
    } catch (error) {
      logger.error({ err: error }, "Error fetching Secretariat action");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/admin/secretariat/actions/:id - edit payload/title (proposed only)
  apiRouter.patch("/actions/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidUuid(id)) return res.status(400).json({ error: "Invalid action id" });

      const { payload, title } = req.body;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: "payload must be an object" });
      }
      if (title !== undefined && typeof title !== 'string') {
        return res.status(400).json({ error: "title must be a string when present" });
      }

      const updated = await secretariatDb.editPayload(id, payload, title);
      if (!updated) {
        return res.status(409).json({ error: "Action is not in proposed state" });
      }
      logger.info({ id }, "Edited Secretariat action payload");
      res.json(updated);
    } catch (error) {
      logger.error({ err: error }, "Error editing Secretariat action");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/secretariat/actions/:id/approve
  apiRouter.post("/actions/:id/approve", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidUuid(id)) return res.status(400).json({ error: "Invalid action id" });

      const approved = await secretariatDb.approve(id, resolveDecider(req));
      if (!approved) {
        return res.status(409).json({ error: "Action is not in proposed state" });
      }
      logger.info({ id, decidedBy: approved.decided_by }, "Approved Secretariat action");
      res.json(approved);
    } catch (error) {
      logger.error({ err: error }, "Error approving Secretariat action");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/secretariat/actions/:id/reject {reason}
  apiRouter.post("/actions/:id/reject", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidUuid(id)) return res.status(400).json({ error: "Invalid action id" });

      const { reason } = req.body;
      if (typeof reason !== 'string' || reason.length === 0) {
        return res.status(400).json({ error: "reason is required" });
      }

      const rejected = await secretariatDb.reject(id, resolveDecider(req), reason);
      if (!rejected) {
        return res.status(409).json({ error: "Action is not in proposed state" });
      }
      logger.info({ id, decidedBy: rejected.decided_by }, "Rejected Secretariat action");
      res.json(rejected);
    } catch (error) {
      logger.error({ err: error }, "Error rejecting Secretariat action");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/secretariat/actions/:id/retry - failed -> proposed
  apiRouter.post("/actions/:id/retry", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidUuid(id)) return res.status(400).json({ error: "Invalid action id" });

      const retried = await secretariatDb.retry(id);
      if (!retried) {
        return res.status(409).json({ error: "Action is not in failed state" });
      }
      logger.info({ id }, "Reset failed Secretariat action to proposed");
      res.json(retried);
    } catch (error) {
      logger.error({ err: error }, "Error retrying Secretariat action");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return { pageRouter, apiRouter };
}
