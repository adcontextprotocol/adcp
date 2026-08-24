/**
 * Agent ownership is a two-part authorization decision:
 *
 * 1. the exact authenticated credential must have live access to an explicit
 *    organization; and
 * 2. that organization must own the requested agent URL.
 *
 * The member profile is the ownership record. Local membership mirrors are
 * deliberately not joined here because they are neither revocation-aware nor
 * safe to union across credentials linked to the same identity.
 */

import { query } from '../db/client.js';
import { canonicalizeAgentUrl } from '../db/publisher-db.js';
import { getWorkos } from '../auth/workos-client.js';
import type { OrgAuthorizationPrincipal } from '../auth/organization-principal.js';
import { resolveUserOrgMembership } from '../utils/resolve-user-org-membership.js';
import type { AgentVisibility } from '../types.js';

/** Resolve an owned agent's visibility inside an already-authorized org. */
export async function findOwnedAgentVisibility(
  organizationId: string,
  agentUrl: string,
): Promise<AgentVisibility | null> {
  try {
    const lookupAgentUrl = canonicalizeAgentUrl(agentUrl) ?? agentUrl;
    const result = await query<{ visibility: string | null }>(
      `SELECT agent->>'visibility' AS visibility
       FROM member_profiles mp
       CROSS JOIN LATERAL jsonb_array_elements(mp.agents) agent
       WHERE mp.workos_organization_id = $1
         AND agent->>'url' = $2
       LIMIT 1`,
      [organizationId, lookupAgentUrl],
    );
    if (!result.rows[0]) return null;
    const visibility = result.rows[0].visibility;
    return visibility === 'public' || visibility === 'members_only' || visibility === 'private'
      ? visibility
      : 'private';
  } catch {
    return null;
  }
}

/** Check only the ownership record; caller authorization is resolved separately. */
export async function isOrgOwnerOfAgent(
  orgId: string,
  _userId: string,
  agentUrl: string,
): Promise<boolean> {
  try {
    const lookupAgentUrl = canonicalizeAgentUrl(agentUrl) ?? agentUrl;
    const result = await query(
      `SELECT 1 FROM member_profiles
       WHERE workos_organization_id = $1
         AND agents @> $2::jsonb
       LIMIT 1`,
      [orgId, JSON.stringify([{ url: lookupAgentUrl }])],
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve an explicit owning organization for the exact request credential.
 * Missing organization context always fails closed; there is no sole/primary
 * organization compatibility fallback.
 */
export async function resolveOwnerOrgForUser(
  principal: OrgAuthorizationPrincipal,
  agentUrl: string,
  requestedOrgId: string | undefined,
): Promise<string | null> {
  if (!requestedOrgId) return null;

  const membership = await resolveUserOrgMembership(getWorkos(), principal, requestedOrgId);
  if (!membership) return null;

  return (await isOrgOwnerOfAgent(requestedOrgId, principal.id, agentUrl))
    ? requestedOrgId
    : null;
}
