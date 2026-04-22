/**
 * Enforce agent visibility tier gates when an organization's subscription
 * changes. If the new tier lacks API access but some agents are marked
 * `public`, demote them to `members_only` and remove those entries from
 * the org's brand.json manifest. Keeps the agent discoverable to fellow
 * API-access members while respecting the gate on public listing.
 */

import { MemberDatabase } from '../db/member-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import { getPool } from '../db/client.js';
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
 *
 * The profile read + write runs inside a single transaction with
 * `SELECT ... FOR UPDATE` on the profile row, so a concurrent PUT /
 * PATCH / publish against the same profile can't reinsert a `public`
 * entry between our read and write. The inner tier check in
 * `applyAgentVisibility` (#2793 follow-up) is the other side of this
 * invariant: it blocks on the same profile row before committing a
 * new `public` write, so the two paths can't interleave past each
 * other's lock.
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

  const pool = getPool();
  const client = await pool.connect();
  let profile: { id: string; agents: AgentConfig[]; primary_brand_domain: string | null } | null = null;
  let demotedUrls = new Set<string>();
  try {
    await client.query('BEGIN');

    const row = await client.query<{
      id: string;
      agents: unknown;
      primary_brand_domain: string | null;
    }>(
      `SELECT id, agents, primary_brand_domain
       FROM member_profiles
       WHERE workos_organization_id = $1
       FOR UPDATE`,
      [orgId],
    );
    if (row.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const r = row.rows[0];
    const parsedAgents = typeof r.agents === 'string'
      ? JSON.parse(r.agents)
      : Array.isArray(r.agents) ? r.agents : [];
    const agents: AgentConfig[] = (parsedAgents as unknown[]).map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const v = o.visibility;
      const visibility = v === 'private' || v === 'members_only' || v === 'public'
        ? v
        : o.is_public === true ? 'public' : 'private';
      return {
        url: String(o.url ?? ''),
        visibility,
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
        ...(typeof o.type === 'string' ? { type: o.type as AgentConfig['type'] } : {}),
      };
    });

    const publicAgents = agents.filter((a) => a.visibility === 'public');
    if (publicAgents.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    demotedUrls = new Set(publicAgents.map((a) => a.url));
    const updatedAgents: AgentConfig[] = agents.map((a) =>
      demotedUrls.has(a.url) ? { ...a, visibility: 'members_only' as const } : a
    );
    profile = { id: r.id, agents: updatedAgents, primary_brand_domain: r.primary_brand_domain };

    await client.query(
      `UPDATE member_profiles
       SET agents = $1::jsonb, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(updatedAgents), r.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!profile) return null;

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

  // Kept for compatibility — MemberDatabase / BrandDatabase args are no
  // longer used for the transactional path, but callers that pass them
  // for testing shouldn't need updating yet.
  void memberDb;

  return { orgId, demotedCount: demotedUrls.size, brandJsonCleared };
}
