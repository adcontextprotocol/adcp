/**
 * API key management routes
 *
 * Proxies to WorkOS widget API for organization API key CRUD.
 * Requires authenticated session (cookie-based auth).
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { createLogger } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";

const logger = createLogger("api-keys-routes");

const WORKOS_API_BASE = "https://api.workos.com";
const WIDGETS_API_VERSION = "1";

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
 * Get a widget token for the given user and organization.
 */
async function getWidgetToken(userId: string, organizationId: string): Promise<string> {
  if (!workos) throw new Error("WorkOS not configured");

  return workos.widgets.getToken({
    organizationId,
    userId,
    scopes: ["widgets:api-keys:manage"],
  });
}

/**
 * Call a WorkOS widget API endpoint.
 */
async function callWidgetApi(
  token: string,
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = new URL(WORKOS_API_BASE);
  url.pathname = path;
  if (params) {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== ""),
    );
    url.search = new URLSearchParams(cleanParams).toString();
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "WorkOS-Widgets-Version": WIDGETS_API_VERSION,
    "WorkOS-Widgets-Type": "ApiKeys",
    "Content-Type": "application/json",
  };

  const response = await fetch(url.toString(), {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let data: unknown;
  if (!text) {
    data = null;
  } else {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  return { status: response.status, data };
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
        return res.status(400).json({ error: "org query parameter is required" });
      }

      const token = await getWidgetToken(req.user!.id, organizationId);
      const { status, data } = await callWidgetApi(
        token,
        "GET",
        "/_widgets/ApiKeys/organization-api-keys",
        {
          ...(req.query.after ? { after: req.query.after as string } : {}),
          ...(req.query.before ? { before: req.query.before as string } : {}),
          ...(req.query.limit ? { limit: req.query.limit as string } : {}),
          ...(req.query.search ? { search: req.query.search as string } : {}),
        },
      );

      res.status(status).json(data);
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

      const token = await getWidgetToken(req.user!.id, organizationId);
      const { status, data } = await callWidgetApi(
        token,
        "POST",
        "/_widgets/ApiKeys/organization-api-keys",
        undefined,
        { name, permissions },
      );

      if (status >= 200 && status < 300) {
        logger.info(
          { userId: req.user!.id, organizationId, keyName: name },
          "API key created",
        );
      } else {
        logger.warn(
          { userId: req.user!.id, organizationId, keyName: name, status, response: data },
          "WorkOS API key creation failed",
        );
      }

      res.status(status).json(data);
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
      const token = await getWidgetToken(req.user!.id, organizationId);
      const { status, data } = await callWidgetApi(
        token,
        "DELETE",
        `/_widgets/ApiKeys/${apiKeyId}`,
      );

      if (status >= 200 && status < 300) {
        logger.info(
          { userId: req.user!.id, organizationId, apiKeyId },
          "API key revoked",
        );
      } else {
        logger.warn(
          { userId: req.user!.id, organizationId, apiKeyId, status },
          "WorkOS API key revocation failed",
        );
      }

      if (status === 204) {
        res.status(204).end();
      } else {
        res.status(status).json(data);
      }
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
