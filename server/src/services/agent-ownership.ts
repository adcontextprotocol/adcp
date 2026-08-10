/**
 * Agent-ownership helpers — single source of truth for "who owns this agent."
 *
 * The ownership relation has three distinct semantic uses:
 *
 *   1. `findOwnerOrgForUser(userId, agentUrl)` — "what org owns this agent
 *      for this user?" Returns the org_id (or null) for ANY org the user
 *      is a member of that has the agent in its member_profile. Used by
 *      callers that only need to establish ownership by any organization.
 *
 *   2. `findSoleOwnerOrgForUser(userId, agentUrl)` — compatibility lookup
 *      for credential-bearing routes whose caller omitted org context. It
 *      succeeds only when exactly one organization matches.
 *
 *   3. `isOrgOwnerOfAgent(orgId, userId, agentUrl)` — "is THIS specific
 *      org the one that owns the agent for this user?" Tighter predicate
 *      than (1): requires the resolved org context to match the agent's
 *      owning org. Used by `evaluate_agent_quality`'s canonical-write
 *      gate where the calling-context org is known and must be confirmed
 *      as the owner (not "some org the user belongs to").
 *
 * All queries join `member_profiles.agents` against `organization_memberships`
 * — the canonical ownership relation. The shared helpers exist because
 * inlining the JOIN at every call site is a drift surface (PR #4250 review
 * flagged the duplication); a single shared helper keeps the predicate in
 * one place.
 *
 * Note on active-membership filtering: `organization_memberships` has no
 * status column in this schema — removed members get their row deleted, not
 * status-flipped. Row existence is the membership signal.
 */

import { query } from '../db/client.js';
import { canonicalizeAgentUrl } from '../db/publisher-db.js';

/**
 * Find the org id of any org the user is a member of that owns the agent.
 * Returns null if no such org exists (user is not the owner, or anonymous).
 *
 * Used for permission checks where we don't yet know which org context the
 * caller is acting from — the resolver discovers it via the join.
 */
export async function findOwnerOrgForUser(
  userId: string,
  agentUrl: string,
): Promise<string | null> {
  try {
    const lookupAgentUrl = canonicalizeAgentUrl(agentUrl) ?? agentUrl;
    const result = await query<{ workos_organization_id: string }>(
      `SELECT mp.workos_organization_id
       FROM member_profiles mp
       JOIN organization_memberships om
         ON om.workos_organization_id = mp.workos_organization_id
       WHERE mp.agents @> $1::jsonb
         AND om.workos_user_id = $2
       LIMIT 1`,
      [JSON.stringify([{ url: lookupAgentUrl }]), userId],
    );
    return result.rows[0]?.workos_organization_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve an owner only when the URL maps to exactly one organization for
 * this user. Credential-bearing routes use this compatibility path when an
 * older caller omits its organization selection. Multiple matches must fail
 * closed: choosing either tenant would select the wrong encryption context.
 */
export async function findSoleOwnerOrgForUser(
  userId: string,
  agentUrl: string,
): Promise<string | null> {
  try {
    const lookupAgentUrl = canonicalizeAgentUrl(agentUrl) ?? agentUrl;
    const result = await query<{ workos_organization_id: string }>(
      `SELECT DISTINCT mp.workos_organization_id
       FROM member_profiles mp
       JOIN organization_memberships om
         ON om.workos_organization_id = mp.workos_organization_id
       WHERE mp.agents @> $1::jsonb
         AND om.workos_user_id = $2
       LIMIT 2`,
      [JSON.stringify([{ url: lookupAgentUrl }]), userId],
    );
    return result.rows.length === 1
      ? result.rows[0].workos_organization_id
      : null;
  } catch {
    return null;
  }
}

/**
 * Verify the given org is the org that owns the agent for the given user.
 * Tighter than `findOwnerOrgForUser` — requires the org_id in the calling
 * context (e.g., the resolved member-context organization) to match the
 * agent's owning org.
 *
 * Used by canonical-state writers (owner-test path in evaluate_agent_quality)
 * to ensure the acting principal's resolved org is actually the owner before
 * persisting public-state changes.
 */
export async function isOrgOwnerOfAgent(
  orgId: string,
  userId: string,
  agentUrl: string,
): Promise<boolean> {
  try {
    const lookupAgentUrl = canonicalizeAgentUrl(agentUrl) ?? agentUrl;
    const result = await query(
      `SELECT 1 FROM member_profiles mp
       JOIN organization_memberships om
         ON om.workos_organization_id = mp.workos_organization_id
       WHERE mp.workos_organization_id = $1
         AND mp.agents @> $2::jsonb
         AND om.workos_user_id = $3
       LIMIT 1`,
      [orgId, JSON.stringify([{ url: lookupAgentUrl }]), userId],
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the owning organization for an agent operation, honoring an
 * explicit dashboard organization when one was supplied.
 *
 * A user can belong to more than one organization that registers the same
 * agent URL. In that case `findOwnerOrgForUser` is intentionally ambiguous;
 * dashboard writes must instead stay inside the organization the user
 * selected. The explicit path therefore fails closed when that organization
 * does not own the agent, rather than silently falling back to another org.
 */
export async function resolveOwnerOrgForUser(
  userId: string,
  agentUrl: string,
  requestedOrgId?: string,
): Promise<string | null> {
  if (requestedOrgId === undefined) {
    return findSoleOwnerOrgForUser(userId, agentUrl);
  }

  return (await isOrgOwnerOfAgent(requestedOrgId, userId, agentUrl))
    ? requestedOrgId
    : null;
}
