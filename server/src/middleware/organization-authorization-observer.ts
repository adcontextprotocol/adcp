import type { Request } from 'express';
import { getAuthorizationObserverWorkos } from '../auth/workos-client.js';
import { createLogger } from '../logger.js';
import { resolveUserRole } from '../utils/resolve-user-role.js';
import { captureEvent } from '../utils/posthog.js';

const logger = createLogger('organization-authorization-observer');
const MAX_CONCURRENT_COMPARISONS = 5;
let inFlightComparisons = 0;

export type OrganizationSelectorSource =
  | 'header'
  | 'query_org'
  | 'query_organization_id'
  | 'body_organization_id'
  | 'body_organizationId'
  | 'path_orgId'
  | 'path_organizationId'
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

const SAFE_ROUTE_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  adagents: 'adagents',
  addie: 'addie',
  admin: 'admin',
  agents: 'agents',
  agreement: 'agreement',
  billing: 'billing',
  brands: 'brands',
  capabilities: 'capabilities',
  certification: 'certification',
  community: 'community',
  companies: 'companies',
  config: 'config',
  conformance: 'conformance',
  content: 'content',
  crawler: 'crawler',
  'creative-agent': 'creative-agent',
  'dev-mode': 'dev-mode',
  'discover-agent': 'discover-agent',
  'email-preferences': 'email-preferences',
  events: 'events',
  invitations: 'invitations',
  'join-requests': 'join-requests',
  'manifest-refs': 'manifest-refs',
  mcp: 'mcp',
  me: 'me',
  meetings: 'meetings',
  members: 'members',
  'network-health': 'network-health',
  newsletter: 'newsletter',
  notifications: 'notifications',
  oauth: 'oauth',
  organizations: 'organizations',
  perspectives: 'perspectives',
  policies: 'policies',
  portraits: 'portraits',
  properties: 'properties',
  public: 'public',
  registry: 'registry',
  search: 'search',
  si: 'si',
  slack: 'slack',
  stats: 'stats',
  storyboards: 'storyboards',
  'training-agent': 'training-agent',
  v1: 'v1',
  validate: 'validate',
  'validate-publisher': 'validate-publisher',
  webhooks: 'webhooks',
  'working-groups': 'working-groups',
});

/**
 * Reduce a normalized request route to a fixed, non-identifying API family.
 * Dynamic or newly introduced top-level segments are deliberately reported as
 * `other`; no user-controlled path value is ever copied into runtime logs.
 */
export function authorizationRouteFamily(route: string): string {
  const match = /^\S+ \/api\/([^/?#\s]+)/.exec(route);
  const segment = match?.[1] ?? '';
  return Object.prototype.hasOwnProperty.call(SAFE_ROUTE_FAMILIES, segment)
    ? SAFE_ROUTE_FAMILIES[segment]
    : 'other';
}

function recordAuthorizationObservation(properties: Record<string, unknown>): void {
  captureEvent('server-metrics', 'org_authorization_shadow', properties);

  // Keep the independently queryable rollout log deliberately identifier-free.
  // Route family comes from the fixed allowlist above; never copy route/path or
  // any credential/organization values into this record. PostHog retains the
  // richer route-level diagnostic event.
  logger.info({
    decision: properties.decision,
    method: properties.method,
    route_family: authorizationRouteFamily(
      typeof properties.route === 'string' ? properties.route : '',
    ),
    response_status: properties.response_status,
    selector_source: properties.selector_source,
    explicit_organization: properties.explicit_organization,
    legacy_allowed: properties.legacy_allowed,
    exact_allowed: properties.exact_allowed,
    legacy_role: properties.legacy_role,
    exact_role: properties.exact_role,
  }, 'org authorization shadow observation');
}

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

  const selector = organizationSelectorFromRequest(req);
  try {
    // This branch controls only which observe-only telemetry event is emitted;
    // it is not an authorization guard and never changes the response.
    if (!selector.organizationId) {
      recordAuthorizationObservation({
        route,
        method: req.method,
        response_status: responseStatus,
        linked_credential: true,
        selector_source: selector.source,
        explicit_organization: false,
        decision: 'no_explicit_organization',
      });
      return;
    }

    if (inFlightComparisons >= MAX_CONCURRENT_COMPARISONS) {
      recordAuthorizationObservation({
        route,
        method: req.method,
        response_status: responseStatus,
        linked_credential: true,
        selector_source: selector.source,
        explicit_organization: true,
        decision: 'observer_saturated',
      });
      return;
    }

    inFlightComparisons += 1;
    try {
      const workos = getAuthorizationObserverWorkos();
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

      recordAuthorizationObservation({
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
    } finally {
      inFlightComparisons -= 1;
    }
  } catch (err) {
    logger.warn(
      { err, route, selectorSource: selector.source },
      'credential-scoped authorization shadow comparison failed',
    );
    recordAuthorizationObservation({
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
