/**
 * Pure builder for the `aao_verification` block that brand.json
 * enrichment appends to agent entries. Extracted from the route
 * handler in registry-api.ts so the dedupe + ordering + version-shape
 * filtering logic has a unit-testable surface.
 *
 * The wire format is documented as {@link AaoVerificationBlock}
 * inline at the call site (registry-api.ts) — that's the contract
 * brand.json consumers see. This file is the implementation; the
 * call site is the public-API boundary.
 */

import type { AgentVerificationBadge } from '../db/compliance-db.js';
import { isValidAdcpVersionShape } from './adcp-taxonomy.js';

export interface AaoVerificationBadgeEntry {
  role: string;
  adcp_version: string | null;
  verification_modes: string[];
  verified_at: string;
}

export interface AaoVerificationBlock {
  verified: true;
  verified_at: string;
  badges: AaoVerificationBadgeEntry[];
  roles: string[];
  modes_by_role: Record<string, string[]>;
  deprecation_notice: string;
}

/**
 * Static deprecation notice that ships alongside the legacy alias
 * fields so a long-tail crawler that doesn't track release notes
 * still sees the warning. Removal target: AdCP 4.0.
 */
export const AAO_VERIFICATION_DEPRECATION_NOTICE =
  'roles[] and modes_by_role reflect the highest-version badge per role only. ' +
  'A buyer pinned to a specific AdCP version SHOULD read badges[] and filter by ' +
  'adcp_version. Both fields will be removed in AdCP 4.0.';

/**
 * Build the `aao_verification` block from a non-empty list of active
 * badges for one agent. Returns `null` if the input is empty so the
 * caller can decide whether to omit the field entirely.
 *
 * Input ordering must match `bulkGetActiveBadges`'s sort
 * (`agent_url, adcp_version DESC, role`). The function picks the
 * first occurrence of each role as that role's highest-version
 * badge — relies on the caller to deliver in the right order.
 *
 * Defense-in-depth: every `adcp_version` in the output array is
 * gated through `isValidAdcpVersionShape`. A poisoned DB row that
 * bypassed the CHECK constraint (raw SQL backfill, restored
 * snapshot, replication slot replay) MUST NOT leak through to the
 * public buyer-facing brand.json surface.
 */
export function buildAaoVerificationBlock(
  badges: readonly AgentVerificationBadge[],
): AaoVerificationBlock | null {
  if (badges.length === 0) return null;

  const byRole = new Map<AgentVerificationBadge['role'], AgentVerificationBadge>();
  for (const badge of badges) {
    if (!byRole.has(badge.role)) byRole.set(badge.role, badge);
  }
  const dedupedBadges = Array.from(byRole.values());

  return {
    verified: true,
    verified_at: dedupedBadges[0].verified_at.toISOString(),
    badges: badges.map(b => ({
      role: b.role,
      adcp_version: isValidAdcpVersionShape(b.adcp_version) ? b.adcp_version : null,
      verification_modes: b.verification_modes,
      verified_at: b.verified_at.toISOString(),
    })),
    roles: dedupedBadges.map(b => b.role),
    modes_by_role: Object.fromEntries(dedupedBadges.map(b => [b.role, b.verification_modes])),
    deprecation_notice: AAO_VERIFICATION_DEPRECATION_NOTICE,
  };
}
