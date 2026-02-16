/**
 * API key management routes
 *
 * Uses WorkOS server-side API for organization API key CRUD.
 * Requires authenticated session (cookie-based auth).
 */

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
        return res.status(400).json({ error: "org query parameter is required" });
      }

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
      res.status(500).json({
        error: "Failed to list API keys",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // POST /api/me/api-keys - Create an API key
  router.post("/", requireAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(500).json({ error: "Authentication not configured" });
      }

      const organizationId = req.query.org as string || req.body.organizationId;
      if (!organizationId) {
        return res.status(400).json({ error: "org query parameter or organizationId in body is required" });
      }

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
      res.status(500).json({
        error: "Failed to create API key",
        message: error instanceof Error ? error.message : "Unknown error",
      });
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
        return res.status(400).json({ error: "org query parameter is required" });
      }

      const apiKeyId = req.params.id;
      await workos.delete(`/api_keys/${apiKeyId}`);

      logger.info(
        { userId: req.user!.id, organizationId, apiKeyId },
        "API key revoked",
      );

      res.status(204).end();
    } catch (error) {
      logger.error({ err: error }, "Error revoking API key");
      res.status(500).json({
        error: "Failed to revoke API key",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
}
