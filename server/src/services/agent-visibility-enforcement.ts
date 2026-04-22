/**
 * Enforce agent visibility tier gates when an organization's subscription
 * changes. If the new tier lacks API access but some agents are marked
 * `public`, demote them to `members_only` and remove those entries from
 * the org's brand.json manifest. Keeps the agent discoverable to fellow
 * API-access members while respecting the gate on public listing.
 */

import { MemberDatabase } from '../db/member-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import {
  hasApiAccess,
  type MembershipTier,
} from '../db/organization-db.js';
import type { AgentConfig } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-visibility-enforcement');

export interface DemoteResult {
  orgId: string;
  demotedCount: number;
  brandJsonCleared: boolean;
}

/**
 * If `oldTier` had API access and `newTier` does not, demote any
 * `public` agents in the org's member_profiles to `members_only` and
 * strip them from the org's primary brand.json manifest.
 *
 * Returns null when no action was taken (no downgrade, or no profile).
 */
export async function demotePublicAgentsOnTierDowngrade(
  orgId: string,
  oldTier: MembershipTier | null,
  newTier: MembershipTier | null,
  memberDb: MemberDatabase = new MemberDatabase(),
  brandDb: BrandDatabase = new BrandDatabase(),
): Promise<DemoteResult | null> {
  if (!hasApiAccess(oldTier)) return null;
  if (hasApiAccess(newTier)) return null;

  const profile = await memberDb.getProfileByOrgId(orgId);
  if (!profile) return null;

  const agents = profile.agents || [];
  const publicAgents = agents.filter((a) => a.visibility === 'public');
  if (publicAgents.length === 0) return null;

  const demotedUrls = new Set(publicAgents.map((a) => a.url));
  const updatedAgents: AgentConfig[] = agents.map((a) =>
    demotedUrls.has(a.url) ? { ...a, visibility: 'members_only' as const } : a
  );

  await memberDb.updateProfileByOrgId(orgId, { agents: updatedAgents });

  let brandJsonCleared = false;
  if (profile.primary_brand_domain) {
    const discovered = await brandDb.getDiscoveredBrandByDomain(profile.primary_brand_domain);
    if (discovered && discovered.source_type !== 'brand_json') {
      const manifest = (discovered.brand_manifest as Record<string, unknown>) || {};
      const currentAgents = Array.isArray(manifest.agents)
        ? (manifest.agents as Array<{ type: string; url: string; id: string }>)
        : [];
      const remaining = currentAgents.filter((a) => !demotedUrls.has(a.url));
      if (remaining.length !== currentAgents.length) {
        await brandDb.updateManifestAgents(profile.primary_brand_domain, remaining, {
          user_id: 'system:tier-downgrade',
          email: 'system@agenticadvertising.org',
          name: 'AAO System',
          summary: 'Tier downgrade: removed publicly-listed agents from brand.json',
        });
        brandJsonCleared = true;
      }
    }
  }

  logger.info(
    { orgId, oldTier, newTier, demotedCount: demotedUrls.size, brandJsonCleared },
    'Demoted public agents to members_only after tier downgrade'
  );

  return { orgId, demotedCount: demotedUrls.size, brandJsonCleared };
}
