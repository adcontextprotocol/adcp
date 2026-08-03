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
import { getQueuesSnapshot } from "../addie/jobs/secretariat-queues.js";

const logger = createLogger("secretariat-admin-routes");

const VALID_STATUSES: SecretariatActionStatus[] = [
  'proposed', 'approved', 'rejected', 'executing', 'done', 'failed',
];

const DEFAULT_REPO = 'adcontextprotocol/adcp';

function isValidUuid(id: string): boolean {
  return uuidValidate(id);
}

/** Who made this decision, for the audit trail. */
function resolveDecider(req: { user?: { email?: string } }): string {
  return req.user?.email ?? 'unknown-admin';
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

  // GET /api/admin/secretariat/queues
  // NOTE: defined before /actions/:id-shaped routes don't collide since path differs.
  apiRouter.get("/queues", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const snapshot = await getQueuesSnapshot(DEFAULT_REPO);
      if (!snapshot) {
        return res.status(502).json({ error: "GitHub lookup unavailable" });
      }
      res.json(snapshot);
    } catch (error) {
      logger.error({ err: error }, "Error building queues snapshot");
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
