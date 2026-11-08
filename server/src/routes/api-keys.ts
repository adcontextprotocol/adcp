/**
 * API key management routes
 *
 * Lists organization API keys through WorkOS. Mutations use WorkOS's
 * user/organization-scoped Widgets API so the provider authorizes the write.
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

  // The server API key is used only for inventory. Mutations below use a
  // user-scoped token, never this unrestricted credential.
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

// WorkOS documents these operations at https://workos.com/docs/widgets-api/api-keys.
// Keep delegation on the server: the browser must not receive a reusable token
// that could bypass our permission allow-list and exact-credential checks.
// WorkOS roles must grant widgets:api-keys:manage to owner/admin, not member.
const CREATE_KEY_MUTATION = `mutation CreateOrganizationApiKey($input: CreateApiKeyInput!) {
  createOrganizationApiKey(input: $input) {
    __typename
    ... on OrganizationApiKeyCreated {
      apiKey { id name createdAt updatedAt expiresAt lastUsedAt obfuscatedValue permissions }
      value
    }
  }
}`;
const REVOKE_KEY_MUTATION = `mutation DeleteOrganizationApiKey($apiKeyId: ID!) {
  deleteOrganizationApiKey(apiKeyId: $apiKeyId) { id }
}`;

class KeyMutationError extends Error {
  constructor(readonly status: 400 | 403 | 503, message: string) { super(message); }
}

function unconfirmedKeyMutation(): KeyMutationError {
  return new KeyMutationError(503, "API key operation could not be confirmed. Check the key list before trying again.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function mutateWorkOSApiKey(
  authorization: ApiKeyManagementAuthorization,
  action: "create" | "revoke",
  variables: Record<string, unknown>,
  assertCurrent: () => Promise<void>,
  assertLive: () => void,
): Promise<Record<string, unknown>> {
  if (!workos) throw new KeyManagementAuthorizationError(503);
  let token: string;
  try {
    ({ token } = await workos.widgets.createToken({
      userId: authorization.actor.authWorkosUserId,
      organizationId: authorization.organizationId,
      scopes: ["widgets:api-keys:manage"],
    }));
    if (!token || typeof token !== "string") throw new Error("Missing widget token");
  } catch (error) {
    // Do not log SDK responses: they can contain credentials. No mutation has
    // been dispatched when token issuance fails.
    const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
    throw new KeyManagementAuthorizationError(status === 401 || status === 403 ? 403 : 503);
  }
  // Token issuance is an awaited provider boundary too. Revalidate the exact
  // credential and membership before sending the single, non-retried write.
  const membership = await requireDirectAdminMembership(
    authorization.actor.authWorkosUserId, authorization.organizationId,
  );
  // Check after the final provider await so its latency cannot consume the
  // local fence's reserved five-second mutation budget.
  await assertCurrent();
  assertLive();
  assertSameMembership(authorization.directMembership, membership);

  let response: globalThis.Response;
  let envelope: unknown;
  try {
    response = await fetch("https://api.workos.com/client/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: action === "create" ? CREATE_KEY_MUTATION : REVOKE_KEY_MUTATION, variables }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (response.ok) envelope = await response.json();
  } catch {
    throw unconfirmedKeyMutation();
  }
  if (response.status === 401 || response.status === 403) throw new KeyManagementAuthorizationError(403);
  if (!response.ok || !isRecord(envelope)) throw unconfirmedKeyMutation();
  // GraphQL can report authorization failure with HTTP 200 and partial data.
  if (envelope.errors !== undefined && !Array.isArray(envelope.errors)) throw unconfirmedKeyMutation();
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const denied = envelope.errors.some((error) => isRecord(error) && (
      error.message === "Unauthorized" || error.message === "Forbidden"
      || (isRecord(error.extensions) && ["UNAUTHENTICATED", "FORBIDDEN"].includes(String(error.extensions.code)))
    ));
    throw new KeyManagementAuthorizationError(denied ? 403 : 503);
  }
  const result = isRecord(envelope.data)
    ? envelope.data[action === "create" ? "createOrganizationApiKey" : "deleteOrganizationApiKey"] : null;
  if (!isRecord(result)) throw unconfirmedKeyMutation();
  if (action === "revoke") {
    if (result.id !== variables.apiKeyId) throw new KeyManagementAuthorizationError(503);
    return result;
  }
  if (["ApiKeyPermissionsNotHeld", "ApiKeyPermissionsUnsupportedForToken"].includes(String(result.__typename))) {
    throw new KeyMutationError(403, "The requested API key permissions are not available to this user");
  }
  if (["InvalidApiKeyName", "InvalidApiKeyPermissions", "InvalidApiKeyExpiration"].includes(String(result.__typename))) {
    throw new KeyMutationError(400, "Invalid API key name or permissions");
  }
  if (result.__typename !== "OrganizationApiKeyCreated" || !isRecord(result.apiKey)
      || typeof result.apiKey.id !== "string" || typeof result.value !== "string" || !result.value) {
    throw new KeyManagementAuthorizationError(503);
  }
  const key = result.apiKey;
  return {
    id: key.id, name: key.name, value: result.value, permissions: key.permissions,
    created_at: key.createdAt, updated_at: key.updatedAt, expires_at: key.expiresAt,
    last_used_at: key.lastUsedAt, obfuscated_value: key.obfuscatedValue,
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
  if (error instanceof KeyMutationError) {
    return res.status(error.status).json({ error: error.message });
  }
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
    res.set("Cache-Control", "no-store");
    try {
      if (!workos) {
        return res.status(503).json({ error: "Organization authorization unavailable" });
      }

      const requestedOrganizationId = selectedOrganizationId(req, res);
      if (!requestedOrganizationId) return;

      const membership = await authorizeKeyManagement(req, res, requestedOrganizationId, "create");
      if (!membership) return;
      const { name, permissions } = req.body;
      await withCurrentKeyManagementAuthorization(membership, async (assertCurrent, assertLive) => {
        if (!name) {
          res.status(400).json({ error: "name is required" });
          return null;
        }
        if (typeof name !== "string" || !name.trim()) {
          res.status(400).json({ error: "Invalid API key name" });
          return;
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

        const result = await mutateWorkOSApiKey(membership, "create", {
          input: { name: name.trim(), permissions: requestedPermissions },
        }, assertCurrent, assertLive);
        // Never expose a newly created secret after an observed authority change.
        // The provider write already succeeded: keep the denial status, but make
        // reconciliation explicit so the caller does not blindly create again.
        try {
          await assertCurrent();
          const currentMembership = await requireDirectAdminMembership(
            membership.actor.authWorkosUserId, membership.organizationId,
          );
          assertLive();
          assertSameMembership(membership.directMembership, currentMembership);
        } catch (error) {
          const status = error instanceof KeyManagementAuthorizationError ? error.status
            : error instanceof ApiKeyManagementStateChangedError ? 403 : 503;
          logger.warn({ ...membership.actor, organizationId: membership.organizationId, apiKeyId: result.id, status },
            "API key created but secret withheld; reconciliation required");
          throw new KeyMutationError(status,
            "API key was created, but its value could not be returned. Check the key list before trying again.");
        }
        logger.info({ ...membership.actor, organizationId: membership.organizationId, apiKeyId: result.id }, "API key created");
        res.status(201).json(result);
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
      await withCurrentKeyManagementAuthorization(membership, async (assertCurrent, assertLive) => {
        // Authorize before terminal input rejection. No provider URL is built.
        if (!isOpaqueWorkOSId(apiKeyId)) {
          res.status(400).json({ error: "Invalid API key ID" });
          return;
        }
        await mutateWorkOSApiKey(membership, "revoke", { apiKeyId }, assertCurrent, assertLive);
        logger.info({ ...membership.actor, organizationId: membership.organizationId, apiKeyId }, "API key revoked");
        res.status(204).end();
      });
    } catch (error) {
      logger.error({ err: error }, "Error revoking API key");
      sendWorkOSError(res, error, "Failed to revoke API key");
    }
  });

  return router;
}
