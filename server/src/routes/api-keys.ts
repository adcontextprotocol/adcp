/**
 * API key management routes
 *
 * Lists organization API keys through WorkOS. Mutations are contained until
 * the provider can enforce a durable membership fence.
 * Requires an authenticated user credential and an explicitly selected org.
 * Verifies fresh, exact-credential authority before every operation.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { createLogger } from "../logger.js";
import { requireApiKeyManagementAuth } from "../middleware/auth.js";
import { getOrganizationAuthorizationUserId } from "../auth/organization-principal.js";
import {
  loadApiKeyManagementSnapshot,
  withApiKeyManagementFence,
  ApiKeyManagementStateChangedError,
} from "../db/api-key-management-db.js";
import {
  AuthorizationSnapshotUnavailableError,
  sameAuthorizationIdentity,
  type AuthorizationSnapshot,
} from "../db/user-authorization-snapshot-db.js";
import { resolveUserRole } from "../utils/resolve-user-role.js";

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

class KeyManagementAuthorizationError extends Error {
  constructor(readonly status: 403 | 503) {
    super(status === 403 ? "Access denied" : "Organization authorization unavailable");
  }
}

// Accept only opaque ASCII identifiers, not paths or encoded paths. Excluding
// dots also prevents URL normalization, which encodeURIComponent alone cannot.
function isOpaqueWorkOSId(value: string): boolean {
  return value.length > 0 && !/[^A-Za-z0-9_-]/.test(value);
}

/** Read only the fixed API-key inventory subresource of a validated organization. */
async function listWorkOSApiKeys(
  organizationId: string,
  options?: { query?: Record<string, string> },
): Promise<{ status: number; data: unknown }> {
  if (!isOpaqueWorkOSId(organizationId)) throw new KeyManagementAuthorizationError(503);
  const url = new URL(WORKOS_BASE_URL);
  url.pathname = `/organizations/${organizationId}/api_keys`;
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${WORKOS_API_KEY}`,
  };

  // Deliberately read-only: no transport path can create or revoke a key until
  // membership revocation and key mutation share an authoritative fence.
  const fetchOptions: RequestInit = { method: "GET", headers, signal: AbortSignal.timeout(5_000) };
  let response: globalThis.Response;
  try {
    response = await fetch(url.toString(), fetchOptions);
  } catch {
    throw new KeyManagementAuthorizationError(503);
  }
  if (!response.ok) {
    const error = new Error(
      `WorkOS API error: ${response.status}`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return { status: 204, data: null };
  }
  try {
    return { status: response.status, data: await response.json() };
  } catch {
    throw new KeyManagementAuthorizationError(503);
  }
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
    supplied.some((value) => typeof value !== "string" || !isOpaqueWorkOSId(value)) ||
    supplied.some((value) => value !== supplied[0])
  ) {
    res.status(400).json({
      error: "Select one organization explicitly",
    });
    return null;
  }
  return supplied[0] as string;
}

interface ApiKeyManagementAuthorization {
  organizationId: string;
  snapshot: AuthorizationSnapshot;
  directMembership: string;
  actor: {
    userId: string;
    authWorkosUserId: string;
    identityId?: string;
  };
}

async function requireDirectAdminMembership(credentialId: string, organizationId: string): Promise<string> {
  if (!workos) throw new KeyManagementAuthorizationError(503);
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: credentialId, organizationId,
    });
    const direct = memberships.data.filter((membership) =>
      membership.userId === credentialId && membership.organizationId === organizationId
        && membership.status === "active",
    );
    // These provider markers detect replacement, role changes and observed ABA.
    // updatedAt is not a monotonic epoch or a provider-enforced mutation lease.
    const records = direct.map((membership) => {
      if (!membership.id || !membership.createdAt || !membership.updatedAt
          || typeof membership.id !== "string" || typeof membership.createdAt !== "string"
          || typeof membership.updatedAt !== "string" || !membership.role?.slug
          || typeof membership.role.slug !== "string"
          || (membership.roles !== undefined && (!Array.isArray(membership.roles)
            || membership.roles.some((entry) => typeof entry?.slug !== "string")))) {
        throw new KeyManagementAuthorizationError(503);
      }
      return JSON.stringify([
        membership.id, membership.userId, membership.organizationId, membership.status,
        membership.role.slug, membership.roles?.map((entry) => entry.slug).sort() ?? null,
        membership.createdAt, membership.updatedAt,
      ]);
    });
    const role = resolveUserRole(direct);
    if (role !== "owner" && role !== "admin") throw new KeyManagementAuthorizationError(403);
    return JSON.stringify(records.sort());
  } catch (error) {
    if (error instanceof KeyManagementAuthorizationError) throw error;
    throw new KeyManagementAuthorizationError(503);
  }
}

function assertSameMembership(previous: string, current: string): void {
  if (previous !== current) throw new KeyManagementAuthorizationError(403);
}

function sendMutationUnavailable(res: Response): void {
  // No feature flag or request override: re-enabling requires a reviewed,
  // durable fence enforced by the same authority as membership mutation.
  res.status(503).json({
    error: "API key mutations unavailable",
    message: "API key creation and revocation are disabled until membership changes can be fenced.",
  });
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

  const snapshot = await loadApiKeyManagementSnapshot(credentialId, organizationId);
  if (!snapshot || (authorizationSnapshot && (
    !sameAuthorizationIdentity(authorizationSnapshot, snapshot)
    || (authorizationSnapshot.selectedOrganizationId !== null
      && authorizationSnapshot.selectedOrganizationId !== organizationId)
  ))) throw new ApiKeyManagementStateChangedError();

  // Only current direct WorkOS membership can authorize secret management.
  // Grants are neither read nor compared, including grants in an old snapshot.
  let directMembership: string;
  try {
    directMembership = await requireDirectAdminMembership(credentialId, organizationId);
  } catch (error) {
    if (!(error instanceof KeyManagementAuthorizationError) || error.status !== 403) throw error;
    res.status(403).json({
      error: "Access denied",
      message: `Only organization owners and admins can ${action} API keys`,
    });
    return null;
  }
  return { organizationId, snapshot, directMembership, actor };
}

async function withCurrentKeyManagementAuthorization<T>(
  authorization: ApiKeyManagementAuthorization,
  effect: (assertCurrent: () => Promise<void>, assertLive: () => void) => Promise<T>,
): Promise<T> {
  return withApiKeyManagementFence(authorization.snapshot, async (assertCurrent, assertLive) => {
    const directMembership = await requireDirectAdminMembership(
      authorization.actor.authWorkosUserId, authorization.organizationId,
    );
    assertSameMembership(authorization.directMembership, directMembership);
    await assertCurrent();
    return effect(assertCurrent, assertLive);
  });
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
  if (error instanceof AuthorizationSnapshotUnavailableError || error instanceof KeyManagementAuthorizationError) {
    const status = error instanceof KeyManagementAuthorizationError ? error.status : 503;
    return res.status(status).json({ error: status === 403 ? "Access denied" : "Organization authorization unavailable" });
  }
  if (error instanceof ApiKeyManagementStateChangedError) {
    return res.status(403).json({ error: "Authorization changed; authenticate again" });
  }
  const status =
    error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;
  res.status(status).json({ error: fallbackMessage });
}

export function createApiKeysRouter(): Router {
  const router = Router();

  // GET /api/me/api-keys - List API keys for an organization
  router.get("/", requireApiKeyManagementAuth, async (req, res) => {
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

      await withCurrentKeyManagementAuthorization(membership, async (assertCurrent, assertLive) => {
        const result = await listWorkOSApiKeys(
          authorizedOrganizationId,
          { query: params },
        );
        // Buffer the entire provider read, then discard it if authority changed.
        // Local locks remain held through emission; no cleanup await precedes it.
        await assertCurrent();
        const currentMembership = await requireDirectAdminMembership(
          membership.actor.authWorkosUserId, authorizedOrganizationId,
        );
        assertLive();
        assertSameMembership(membership.directMembership, currentMembership);
        res.json(result.data);
      });
    } catch (error) {
      logger.error({ err: error }, "Error listing API keys");
      sendWorkOSError(res, error, "Failed to list API keys");
    }
  });

  // POST /api/me/api-keys - Create an API key
  router.post("/", requireApiKeyManagementAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(503).json({ error: "Organization authorization unavailable" });
      }

      const requestedOrganizationId = selectedOrganizationId(req, res);
      if (!requestedOrganizationId) return;

      const membership = await authorizeKeyManagement(req, res, requestedOrganizationId, "create");
      if (!membership) return;
      const { name, permissions } = req.body;
      await withCurrentKeyManagementAuthorization(membership, async () => {
        if (!name) {
          res.status(400).json({ error: "name is required" });
          return null;
        }

        if (
          permissions !== undefined &&
          (!Array.isArray(permissions) ||
            permissions.some((permission) => typeof permission !== "string"))
        ) {
          res.status(400).json({
            error: "Invalid permissions",
            message: "permissions must be an array of supported permission strings",
          });
          return null;
        }

        const requestedPermissions = [
          ...new Set((permissions as string[] | undefined) ?? []),
        ];
        const unsupportedPermissions = requestedPermissions.filter(
          (permission) => !ALLOWED_PRIVILEGED_PERMISSIONS.has(permission),
        );
        if (unsupportedPermissions.length > 0) {
          res.status(400).json({
            error: "Invalid permissions",
            message: "One or more requested permissions are not supported",
          });
          return null;
        }

        sendMutationUnavailable(res);
      });
    } catch (error) {
      logger.error({ err: error }, "Error creating API key");
      sendWorkOSError(res, error, "Failed to create API key");
    }
  });

  // DELETE /api/me/api-keys/:id - Revoke an API key
  router.delete("/:id", requireApiKeyManagementAuth, async (req, res) => {
    try {
      if (!workos) {
        return res.status(503).json({ error: "Organization authorization unavailable" });
      }

      const requestedOrganizationId = selectedOrganizationId(req, res);
      if (!requestedOrganizationId) return;

      const membership = await authorizeKeyManagement(req, res, requestedOrganizationId, "revoke");
      if (!membership) return;
      const apiKeyId = req.params.id;
      await withCurrentKeyManagementAuthorization(membership, async () => {
        // Authorize before terminal input rejection. No provider URL is built.
        if (!isOpaqueWorkOSId(apiKeyId)) {
          res.status(400).json({ error: "Invalid API key ID" });
          return;
        }
        sendMutationUnavailable(res);
      });
    } catch (error) {
      logger.error({ err: error }, "Error revoking API key");
      sendWorkOSError(res, error, "Failed to revoke API key");
    }
  });

  return router;
}
