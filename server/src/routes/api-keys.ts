/**
 * API key management routes
 *
 * Uses WorkOS API for organization API key CRUD.
 * Requires an authenticated user credential and an explicitly selected org.
 * Verifies fresh, exact-credential authority before every operation.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { createLogger } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";
import { getOrganizationAuthorizationUserId } from "../auth/organization-principal.js";
import {
  evaluateUserOrgRoleAuthorization,
  resolveUserOrgAuthorization,
  type UserOrgAuthorizationMembership,
} from "../utils/resolve-user-org-authorization.js";

const logger = createLogger("api-keys-routes");

// These are the only elevated permissions the server recognizes for
// tenant-scoped WorkOS API keys. Keep this allow-list next to issuance so a
// caller cannot mint new authority merely by inventing a permission string.
const ALLOWED_PRIVILEGED_PERMISSIONS = new Set(["admin:read", "admin:*"]);

const WORKOS_API_KEY = process.env.WORKOS_API_KEY;
const WORKOS_BASE_URL = "https://api.workos.com";

const AUTH_ENABLED = !!(
  WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

const workos = AUTH_ENABLED
  ? new WorkOS(WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
      timeout: 5_000,
      maxRetries: 0,
    })
  : null;

/**
 * Make a direct HTTP request to the WorkOS API.
 * Used for endpoints without dedicated SDK methods (e.g., API key management).
 */
async function workosRequest(
  method: string,
  path: string,
  options?: { query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const url = new URL(path, WORKOS_BASE_URL);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${WORKOS_API_KEY}`,
  };

  const fetchOptions: RequestInit = { method, headers };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  // CodeQL: URL is constructed from hardcoded https://api.workos.com base + API path
  const response = await fetch(url.toString(), fetchOptions); // lgtm[js/request-forgery]
  if (!response.ok) {
    let body: string;
    try {
      body = await response.text();
    } catch {
      body = "(unable to read response body)";
    }
    const error = new Error(
      `WorkOS API error: ${response.status} ${body}`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return { status: 204, data: null };
  }
  return { status: response.status, data: await response.json() };
}

/**
 * Select only an explicit request organization. Never consult a session's org,
 * the canonical identity, or a primary/first organization. Conflicting selectors
 * are ambiguous even when the caller can administer both organizations.
 */
function selectedOrganizationId(
  req: Request,
  res: Response,
): string | null {
  // These are the same explicit selectors recognized by the authorization
  // observer. Require agreement rather than giving one location precedence.
  const headerOrg = req.headers["x-organization-id"];
  const supplied: unknown[] = [
    req.query.org,
    req.query.organization_id,
    req.query.organizationId,
    req.body?.organizationId,
    req.body?.organization_id,
    headerOrg,
  ].filter((value) => value !== undefined);
  const headerCount = req.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "x-organization-id",
  ).length;
  if (
    supplied.length === 0 ||
    headerCount > 1 ||
    (typeof headerOrg === "string" && headerOrg.includes(",")) ||
    supplied.some((value) => typeof value !== "string" || !value || value !== value.trim()) ||
    supplied.some((value) => value !== supplied[0])
  ) {
    res.status(400).json({
      error: "Select one organization explicitly",
    });
    return null;
  }
  return supplied[0] as string;
}

interface ApiKeyManagementAuthorization extends UserOrgAuthorizationMembership {
  actor: {
    userId: string;
    authWorkosUserId: string;
    identityId?: string;
  };
}

/**
 * API key creation, inventory, and revocation are organization-wide
 * operations: keys act for the organization, listing exposes privileged
 * automation keys, and revocation can disable them. Keep the full lifecycle
 * restricted to active organization owners and admins.
 */
async function authorizeKeyManagement(
  req: Request,
  res: Response,
  organizationId: string,
  action: "create" | "list" | "revoke",
): Promise<ApiKeyManagementAuthorization | null> {
  const credentialId = getOrganizationAuthorizationUserId(req.user!);
  const authorizationSnapshot = req.user!.authorizationSnapshot;
  // Preserve authentication-time attribution across provider awaits. Snapshot
  // state is non-enumerable, so carry it explicitly into the authorization check.
  const actor = {
    userId: authorizationSnapshot?.canonicalUserId ?? req.user!.id,
    authWorkosUserId: credentialId,
    identityId: authorizationSnapshot
      ? authorizationSnapshot.identityId ?? undefined
      : req.user!.identityId,
  };
  // Key-use permissions (including tenant admin:*) do not grant key-management
  // authority or impersonation of a user credential.
  if (credentialId === "admin_api_key" || credentialId.startsWith("api_key_")) {
    res.status(403).json({ error: "A user credential is required to manage API keys" });
    return null;
  }

  // No cached organization_memberships or linked credentials participate here.
  // Existing grants explicitly assign a role to this exact credential and org;
  // they do not delegate use of another binding or inherit its membership.
  const resolution = await resolveUserOrgAuthorization(
    workos,
    { id: actor.userId, authWorkosUserId: actor.authWorkosUserId, authorizationSnapshot },
    organizationId,
  );
  const decision = evaluateUserOrgRoleAuthorization(resolution, "admin");
  if (decision.status === "unavailable") {
    res.status(503).json({ error: "Organization authorization unavailable" });
    return null;
  }
  if (decision.status === "authorized" && decision.membership.organizationId === organizationId) {
    return { ...decision.membership, actor };
  }

  res.status(403).json({
    error: "Access denied",
    message: `Only organization owners and admins can ${action} API keys`,
  });
  return null;
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
        return res.status(503).json({ error: "Organization authorization unavailable" });
      }

      const requestedOrganizationId = selectedOrganizationId(req, res);
      if (!requestedOrganizationId) return;

      const membership = await authorizeKeyManagement(req, res, requestedOrganizationId, "list");
      if (!membership) return;
      const authorizedOrganizationId = membership.organizationId;

      const params: Record<string, string> = {};
      if (req.query.after) params.after = req.query.after as string;
      if (req.query.before) params.before = req.query.before as string;
      if (req.query.limit) params.limit = req.query.limit as string;

      const result = await workosRequest(
        "GET",
        `/organizations/${encodeURIComponent(authorizedOrganizationId)}/api_keys`,
        { query: params },
      );

      res.json(result.data);
    } catch (error) {
      logger.error({ err: error }, "Error listing API keys");
      sendWorkOSError(res, error, "Failed to list API keys");
    }
  });

  // POST /api/me/api-keys - Create an API key
  router.post("/", requireAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(503).json({ error: "Organization authorization unavailable" });
      }

      const requestedOrganizationId = selectedOrganizationId(req, res);
      if (!requestedOrganizationId) return;

      const membership = await authorizeKeyManagement(req, res, requestedOrganizationId, "create");
      if (!membership) return;
      const authorizedOrganizationId = membership.organizationId;

      const { name, permissions } = req.body;
      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }

      if (
        permissions !== undefined &&
        (!Array.isArray(permissions) ||
          permissions.some((permission) => typeof permission !== "string"))
      ) {
        return res.status(400).json({
          error: "Invalid permissions",
          message: "permissions must be an array of supported permission strings",
        });
      }

      const requestedPermissions = [
        ...new Set((permissions as string[] | undefined) ?? []),
      ];
      const unsupportedPermissions = requestedPermissions.filter(
        (permission) => !ALLOWED_PRIVILEGED_PERMISSIONS.has(permission),
      );
      if (unsupportedPermissions.length > 0) {
        return res.status(400).json({
          error: "Invalid permissions",
          message: "One or more requested permissions are not supported",
        });
      }

      const body: { name: string; permissions?: string[] } = { name };
      if (requestedPermissions.length > 0) {
        body.permissions = requestedPermissions;
      }

      const result = await workosRequest(
        "POST",
        `/organizations/${encodeURIComponent(authorizedOrganizationId)}/api_keys`,
        { body },
      );

      logger.info(
        {
          ...membership.actor,
          organizationId: authorizedOrganizationId,
          keyName: name,
        },
        "API key created",
      );

      res.status(201).json(result.data);
    } catch (error) {
      logger.error({ err: error }, "Error creating API key");
      sendWorkOSError(res, error, "Failed to create API key");
    }
  });

  // DELETE /api/me/api-keys/:id - Revoke an API key
  router.delete("/:id", requireAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(503).json({ error: "Organization authorization unavailable" });
      }

      const requestedOrganizationId = selectedOrganizationId(req, res);
      if (!requestedOrganizationId) return;

      const membership = await authorizeKeyManagement(req, res, requestedOrganizationId, "revoke");
      if (!membership) return;
      const authorizedOrganizationId = membership.organizationId;

      const apiKeyId = req.params.id;
      // Every accepted route ID first completes exact admin authorization.
      // URL normalizes dot segments even after encodeURIComponent, so reject
      // them before a key DELETE can become a request to the organization.
      if (apiKeyId === "." || apiKeyId === "..") {
        return res.status(400).json({ error: "Invalid API key ID" });
      }

      try {
        await workosRequest("DELETE", `/organizations/${encodeURIComponent(authorizedOrganizationId)}/api_keys/${encodeURIComponent(apiKeyId)}`);
        logger.info(
          {
            ...membership.actor,
            organizationId: authorizedOrganizationId,
            apiKeyId,
          },
          "API key revoked",
        );
      } catch (error) {
        const status =
          error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number"
            ? (error as { status: number }).status
            : null;
        if (status !== 404) throw error;
        logger.info(
          {
            ...membership.actor,
            organizationId: authorizedOrganizationId,
            apiKeyId,
          },
          "API key revoke: already absent in WorkOS",
        );
      }

      res.status(204).end();
    } catch (error) {
      logger.error({ err: error }, "Error revoking API key");
      sendWorkOSError(res, error, "Failed to revoke API key");
    }
  });

  return router;
}
