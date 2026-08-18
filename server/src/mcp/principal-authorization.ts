import { getWorkos } from '../auth/workos-client.js';
import { bansDb } from '../db/bans-db.js';
import type { MCPAuthContext } from './auth.js';

export type MCPAuthorizationDenial =
  | 'authentication_required'
  | 'machine_token_not_supported'
  | 'platform_banned'
  | 'inactive_organization_membership';

export type MCPAuthorizationDecision =
  | { authorized: true }
  | { authorized: false; reason: MCPAuthorizationDenial };

/**
 * Revalidate the mutable authorization facts that are not guaranteed by a
 * correctly signed WorkOS JWT. This gate runs on every authenticated MCP
 * request before the server exposes or invokes tools.
 *
 * AAO's OAuth server does not support client_credentials for MCP. Machine
 * callers use organization API keys on the REST API instead, so accepting an
 * M2M JWT here would create an organization authority model that does not
 * otherwise exist.
 */
export async function authorizeMCPPrincipal(
  auth: MCPAuthContext | undefined,
): Promise<MCPAuthorizationDecision> {
  if (!auth?.sub || auth.sub === 'anonymous' || auth.sub === 'unknown') {
    return { authorized: false, reason: 'authentication_required' };
  }

  if (auth.isM2M) {
    return { authorized: false, reason: 'machine_token_not_supported' };
  }

  const ban = auth.orgId
    ? await bansDb.checkPlatformBanForUserAndOrg(auth.sub, auth.orgId)
    : await bansDb.checkPlatformBan(auth.sub);
  if (ban.banned) {
    return { authorized: false, reason: 'platform_banned' };
  }

  // A user token without an organization can still use public evaluation
  // tools. Once an org claim is present, every organization-scoped capability
  // must be bound to the caller's current active WorkOS membership rather than
  // the historical claim in the signed token.
  if (!auth.orgId) {
    return { authorized: true };
  }

  const memberships = await getWorkos().userManagement.listOrganizationMemberships({
    userId: auth.sub,
    organizationId: auth.orgId,
  });
  const hasActiveMembership = memberships.data.some(
    (membership) =>
      membership.organizationId === auth.orgId && membership.status === 'active',
  );

  if (!hasActiveMembership) {
    return { authorized: false, reason: 'inactive_organization_membership' };
  }

  return { authorized: true };
}
