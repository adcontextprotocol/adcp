/**
 * Build the identity-only adagents.json document stored by community-registry
 * write surfaces.
 *
 * Community contributors, administrators, and Addie can curate catalog and
 * identity data, but they cannot authorize a sales agent on a publisher's
 * behalf. Authorization is sourced only from the publisher's origin-hosted
 * adagents.json, so caller-provided values must always be replaced with an
 * explicit empty array.
 *
 * Do not use this helper on origin-crawled documents.
 */
export function scrubCommunityAuthorizedAgents(
  adagentsJson: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...adagentsJson,
    authorized_agents: [],
  };
}
