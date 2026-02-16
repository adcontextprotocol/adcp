/**
 * API key management routes
 *
 * Uses WorkOS server-side API for organization API key CRUD.
 * Requires authenticated session (cookie-based auth).
 * Verifies org membership before allowing any operation.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { createLogger } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";

const logger = createLogger("api-keys-routes");

const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
    })
  : null;

/**
 * Verify the authenticated user is a member of the specified organization.
 * Returns true if verified, false if not (and sends the appropriate error response).
 */
async function verifyOrgMembership(
  req: Request,
  res: Response,
  organizationId: string,
): Promise<boolean> {
  const memberships =
    await workos!.userManagement.listOrganizationMemberships({
      userId: req.user!.id,
      organizationId,
    });

  if (memberships.data.length === 0) {
    res.status(403).json({
      error: "Access denied",
      message: "You are not a member of this organization",
    });
    return false;
  }
  return true;
}

/**
 * Send an appropriate error response for a WorkOS API error.
 * Forwards the HTTP status code if present on the error; defaults to 500.
 */
function sendWorkOSError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
) {
  const status =
    error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;
  res.status(status).json({ error: fallbackMessage });
}

export function createApiKeysRouter(): Router {
  const router = Router();

  // GET /api/me/api-keys - List API keys for an organization
  router.get("/", requireAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(500).json({ error: "Authentication not configured" });
      }

      const organizationId = req.query.org as string;
      if (!organizationId) {
        return res
          .status(400)
          .json({ error: "org query parameter is required" });
      }

      if (!(await verifyOrgMembership(req, res, organizationId))) return;

      const params: Record<string, string> = {};
      if (req.query.after) params.after = req.query.after as string;
      if (req.query.before) params.before = req.query.before as string;
      if (req.query.limit) params.limit = req.query.limit as string;

      const { data } = await workos.get(
        `/organizations/${organizationId}/api_keys`,
        { query: params },
      );

      res.json(data);
    } catch (error) {
      logger.error({ err: error }, "Error listing API keys");
      sendWorkOSError(res, error, "Failed to list API keys");
    }
  });

  // POST /api/me/api-keys - Create an API key
  router.post("/", requireAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(500).json({ error: "Authentication not configured" });
      }

      const organizationId =
        (req.query.org as string) || req.body.organizationId;
      if (!organizationId) {
        return res.status(400).json({
          error: "org query parameter or organizationId in body is required",
        });
      }

      if (!(await verifyOrgMembership(req, res, organizationId))) return;

      const { name, permissions } = req.body;
      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }

      const body: { name: string; permissions?: string[] } = { name };
      if (permissions && permissions.length > 0) {
        body.permissions = permissions;
      }

      const { data } = await workos.post(
        `/organizations/${organizationId}/api_keys`,
        body,
      );

      logger.info(
        { userId: req.user!.id, organizationId, keyName: name },
        "API key created",
      );

      res.status(201).json(data);
    } catch (error) {
      logger.error({ err: error }, "Error creating API key");
      sendWorkOSError(res, error, "Failed to create API key");
    }
  });

  // DELETE /api/me/api-keys/:id - Revoke an API key
  router.delete("/:id", requireAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(500).json({ error: "Authentication not configured" });
      }

      const organizationId = req.query.org as string;
      if (!organizationId) {
        return res
          .status(400)
          .json({ error: "org query parameter is required" });
      }

      if (!(await verifyOrgMembership(req, res, organizationId))) return;

      const apiKeyId = req.params.id;
      await workos.delete(`/api_keys/${apiKeyId}`);

      logger.info(
        { userId: req.user!.id, organizationId, apiKeyId },
        "API key revoked",
      );

      res.status(204).end();
    } catch (error) {
      logger.error({ err: error }, "Error revoking API key");
      sendWorkOSError(res, error, "Failed to revoke API key");
    }
  });

  return router;
}
