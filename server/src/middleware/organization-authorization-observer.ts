import type { Request } from 'express';
import { getWorkos } from '../auth/workos-client.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { createLogger } from '../logger.js';
import { resolveUserRole } from '../utils/resolve-user-role.js';
import { captureEvent } from '../utils/posthog.js';

const logger = createLogger('organization-authorization-observer');

export type OrganizationSelectorSource =
  | 'header'
  | 'query_org'
  | 'query_organization_id'
  | 'body_organization_id'
  | 'body_organizationId'
  | 'path_orgId'
  | 'path_organizationId'
  | 'legacy_primary'
  | 'none';

type RequestWithAuthContext = Pick<Request, 'headers' | 'query' | 'body' | 'params' | 'method'> & {
  user?: {
    id?: string;
    authWorkosUserId?: string;
  };
};

export interface OrganizationSelector {
  organizationId: string | null;
  source: OrganizationSelectorSource;
  explicit: boolean;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read the explicit organization selectors already supported by the server.
 * This is observation-only: it never mutates the request or supplies a
 * fallback to authorization code.
 */
export function organizationSelectorFromRequest(
  req: Pick<RequestWithAuthContext, 'headers' | 'query' | 'body' | 'params'>,
): OrganizationSelector {
  const header = nonEmptyString(req.headers['x-organization-id']);
  if (header) return { organizationId: header, source: 'header', explicit: true };

  const queryOrg = nonEmptyString(req.query?.org);
  if (queryOrg) return { organizationId: queryOrg, source: 'query_org', explicit: true };

  const queryOrganizationId = nonEmptyString(req.query?.organization_id);
  if (queryOrganizationId) {
    return { organizationId: queryOrganizationId, source: 'query_organization_id', explicit: true };
  }

  const body = req.body && typeof req.body === 'object'
    ? req.body as Record<string, unknown>
    : {};
  const bodyOrganizationId = nonEmptyString(body.organization_id);
  if (bodyOrganizationId) {
    return { organizationId: bodyOrganizationId, source: 'body_organization_id', explicit: true };
  }

  const bodyOrganizationIdCamel = nonEmptyString(body.organizationId);
  if (bodyOrganizationIdCamel) {
    return { organizationId: bodyOrganizationIdCamel, source: 'body_organizationId', explicit: true };
  }

  const pathOrgId = nonEmptyString(req.params?.orgId);
  if (pathOrgId) return { organizationId: pathOrgId, source: 'path_orgId', explicit: true };

  const pathOrganizationId = nonEmptyString(req.params?.organizationId);
  if (pathOrganizationId) {
    return { organizationId: pathOrganizationId, source: 'path_organizationId', explicit: true };
  }

  return { organizationId: null, source: 'none', explicit: false };
}

type MembershipSummary = {
  allowed: boolean;
  role: string | null;
};

function summarizeMemberships(
  memberships: Array<{ organizationId: string; status?: string; role?: { slug?: string } | null }>,
  organizationId: string,
): MembershipSummary {
  const matching = memberships.filter(
    (membership) => membership.organizationId === organizationId && membership.status === 'active',
  );
  if (matching.length === 0) return { allowed: false, role: null };
  return {
    allowed: true,
    role: resolveUserRole(matching as Parameters<typeof resolveUserRole>[0]) ?? null,
  };
}

export function classifyAuthorizationObservation(
  legacy: MembershipSummary,
  exact: MembershipSummary,
): string {
  if (legacy.allowed && !exact.allowed) return 'legacy_allow_exact_deny';
  if (!legacy.allowed && exact.allowed) return 'legacy_deny_exact_allow';
  if (!legacy.allowed && !exact.allowed) return 'both_deny';
  return legacy.role === exact.role ? 'both_allow_same_role' : 'both_allow_role_mismatch';
}

/**
 * Compare the shipped canonical-credential decision with the proposed exact-
 * credential decision after a response has completed. The comparison is
 * deliberately side-effect free and never changes the response.
 *
 * Only linked, non-primary sessions need the extra WorkOS reads. Events carry
 * route/decision metadata but no user, identity, email, or organization IDs.
 */
export async function observeLinkedCredentialOrganizationAuthorization(
  req: RequestWithAuthContext,
  route: string,
  responseStatus: number,
): Promise<void> {
  if (process.env.ORG_AUTHORIZATION_OBSERVER_ENABLED === 'false') return;

  const canonicalUserId = req.user?.id;
  const authenticatedUserId = req.user?.authWorkosUserId;
  if (!canonicalUserId || !authenticatedUserId || canonicalUserId === authenticatedUserId) return;

  let selector = organizationSelectorFromRequest(req);
  try {
    if (!selector.organizationId) {
      const legacyOrganizationId = await resolvePrimaryOrganization(canonicalUserId);
      selector = legacyOrganizationId
        ? { organizationId: legacyOrganizationId, source: 'legacy_primary', explicit: false }
        : selector;
    }

    if (!selector.organizationId) {
      captureEvent('server-metrics', 'org_authorization_shadow', {
        route,
        method: req.method,
        response_status: responseStatus,
        linked_credential: true,
        selector_source: selector.source,
        explicit_organization: false,
        decision: 'no_organization',
      });
      return;
    }

    const workos = getWorkos();
    const [legacyMemberships, exactMemberships] = await Promise.all([
      workos.userManagement.listOrganizationMemberships({
        userId: canonicalUserId,
        organizationId: selector.organizationId,
      }),
      workos.userManagement.listOrganizationMemberships({
        userId: authenticatedUserId,
        organizationId: selector.organizationId,
      }),
    ]);
    const legacy = summarizeMemberships(legacyMemberships.data, selector.organizationId);
    const exact = summarizeMemberships(exactMemberships.data, selector.organizationId);

    captureEvent('server-metrics', 'org_authorization_shadow', {
      route,
      method: req.method,
      response_status: responseStatus,
      linked_credential: true,
      selector_source: selector.source,
      explicit_organization: selector.explicit,
      decision: classifyAuthorizationObservation(legacy, exact),
      legacy_allowed: legacy.allowed,
      exact_allowed: exact.allowed,
      legacy_role: legacy.role,
      exact_role: exact.role,
    });
  } catch (err) {
    logger.warn(
      { err, route, selectorSource: selector.source },
      'credential-scoped authorization shadow comparison failed',
    );
    captureEvent('server-metrics', 'org_authorization_shadow', {
      route,
      method: req.method,
      response_status: responseStatus,
      linked_credential: true,
      selector_source: selector.source,
      explicit_organization: selector.explicit,
      decision: 'lookup_error',
    });
  }
}
