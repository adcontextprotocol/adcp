/**
 * Badge issuance service — called after compliance runs to issue/revoke/degrade
 * AAO Verified badges based on specialism results.
 */

import { ComplianceDatabase, DEFAULT_BADGE_ADCP_VERSION, type BadgeRole, type StoryboardStatus, type StoryboardStatusEntry } from '../db/compliance-db.js';
import { deriveVerificationStatus } from '../addie/services/compliance-testing.js';
import { signVerificationToken, isTokenSigningEnabled } from './verification-token.js';
import { isVerificationMode, SUPPORTED_BADGE_VERSIONS, type VerificationMode } from './adcp-taxonomy.js';
import { getStoryboardIdsForVersion } from './storyboards.js';
import { API_ACCESS_TIERS, ACTIVE_SUBSCRIPTION_STATUSES } from './membership-tiers.js';
import { query } from '../db/client.js';
import { notifySystemError } from '../addie/error-notifier.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'badge-issuance' });

export interface BadgeIssuanceResult {
  // Each entry includes adcp_version so the caller can route per-version
  // issuances to the right notification text without re-deriving from
  // surrounding loop state.
  issued: Array<{ role: BadgeRole; specialisms: string[]; adcp_version: string }>;
  revoked: Array<{ role: BadgeRole; reason: string; adcp_version: string }>;
  degraded: Array<{ role: BadgeRole; adcp_version: string }>;
  unchanged: Array<{ role: BadgeRole; adcp_version: string }>;
}

/**
 * Check and update badge status for an agent after a compliance run.
 *
 * Called from the heartbeat job after recordComplianceRun().
 *
 * @param agentUrl - The agent URL
 * @param declaredSpecialisms - Specialism IDs the agent declared in get_adcp_capabilities
 * @param storyboardStatuses - Latest storyboard results from the compliance run
 * @param overallPassing - Whether the overall compliance run was passing
 * @param membershipOrgId - The org that owns the agent (for membership gating)
 */
export async function processAgentBadges(
  complianceDb: ComplianceDatabase,
  agentUrl: string,
  declaredSpecialisms: string[],
  storyboardStatuses: StoryboardStatusEntry[],
  overallPassing: boolean,
  membershipOrgId?: string,
  adcpVersion: string = DEFAULT_BADGE_ADCP_VERSION,
): Promise<BadgeIssuanceResult> {
  const result: BadgeIssuanceResult = { issued: [], revoked: [], degraded: [], unchanged: [] };

  if (declaredSpecialisms.length === 0) {
    return result;
  }

  const verification = deriveVerificationStatus(declaredSpecialisms, storyboardStatuses);
  const existingAllVersions = await complianceDb.getBadgesForAgent(agentUrl);

  // Membership is an agent-level fact, not a version-level fact. When
  // membership lapses, every badge across every version must revoke
  // immediately — not just the version under test. Otherwise a non-paying
  // agent's other-version badges would keep signaling "AAO Verified" until
  // their own heartbeats land (12-24h later), which is wrong for a public
  // trust mark.
  if (!membershipOrgId) {
    for (const existing of existingAllVersions) {
      await complianceDb.revokeBadge(agentUrl, existing.role, existing.adcp_version, 'Membership lapsed');
      result.revoked.push({ role: existing.role, reason: 'Membership lapsed', adcp_version: existing.adcp_version });
      logger.info({ agentUrl, role: existing.role, adcpVersion: existing.adcp_version }, 'Badge revoked — membership lapsed');
    }
    return result;
  }

  // Scope further reads/writes to the AdCP version we're processing —
  // for issuance, degradation, and 48-hour-grace revocation, this run
  // only touches its own version. A 3.1 failing run never affects a 3.0
  // badge and vice-versa.
  const existingBadges = existingAllVersions.filter(b => b.adcp_version === adcpVersion);
  const existingByRole = new Map(existingBadges.map(b => [b.role, b]));

  for (const roleResult of verification.roles) {
    const existing = existingByRole.get(roleResult.role);

    if (roleResult.verified) {
      // Spec-only issuance for now. The 'live' axis lights up later when the
      // canonical-campaign runner ships; an existing 'live' mode on a badge
      // is preserved (we only add 'spec' here, never remove 'live').
      // Filter existing modes through the known set so a corrupted DB row
      // can't pollute a re-asserted badge. 'spec' is unconditionally added
      // because we got here from a passing storyboard heartbeat.
      const existingModes = (existing?.verification_modes ?? []).filter(isVerificationMode);
      const modes: VerificationMode[] = Array.from(new Set<VerificationMode>(['spec', ...existingModes]));

      let token: string | undefined;
      let tokenExpiresAt: Date | undefined;
      if (isTokenSigningEnabled()) {
        const signed = await signVerificationToken({
          agent_url: agentUrl,
          role: roleResult.role,
          verified_specialisms: roleResult.specialisms,
          verification_modes: modes,
          adcp_version: adcpVersion,
        });
        if (signed) {
          token = signed.token;
          tokenExpiresAt = signed.expires_at;
        }
      }

      await complianceDb.upsertBadge({
        agent_url: agentUrl,
        role: roleResult.role,
        adcp_version: adcpVersion,
        verified_specialisms: roleResult.specialisms,
        verification_modes: modes,
        verification_token: token,
        token_expires_at: tokenExpiresAt,
        membership_org_id: membershipOrgId,
      });

      if (!existing) {
        result.issued.push({ role: roleResult.role, specialisms: roleResult.specialisms, adcp_version: adcpVersion });
        logger.info({ agentUrl, role: roleResult.role, adcpVersion, specialisms: roleResult.specialisms }, 'Badge issued');
      } else {
        result.unchanged.push({ role: roleResult.role, adcp_version: adcpVersion });
      }
    } else if (existing) {
      if (existing.status === 'active') {
        await complianceDb.degradeBadge(agentUrl, roleResult.role, adcpVersion);
        result.degraded.push({ role: roleResult.role, adcp_version: adcpVersion });
        logger.info({ agentUrl, role: roleResult.role, adcpVersion, failing: roleResult.failing }, 'Badge degraded');
      } else if (existing.status === 'degraded') {
        const degradedAt = existing.updated_at;
        const hoursSinceDegraded = (Date.now() - degradedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceDegraded >= 48) {
          await complianceDb.revokeBadge(agentUrl, roleResult.role, adcpVersion, `Specialisms failing for 48+ hours: ${roleResult.failing.join(', ')}`);
          result.revoked.push({ role: roleResult.role, reason: `Failing specialisms: ${roleResult.failing.join(', ')}`, adcp_version: adcpVersion });
          logger.info({ agentUrl, role: roleResult.role, adcpVersion, failing: roleResult.failing }, 'Badge revoked after 48h grace');
        } else {
          result.unchanged.push({ role: roleResult.role, adcp_version: adcpVersion });
        }
      }
    }
  }

  // Revoke badges on roles that are no longer declared
  const activeRoles = new Set(verification.roles.map(r => r.role));
  for (const existing of existingBadges) {
    if (!activeRoles.has(existing.role)) {
      await complianceDb.revokeBadge(agentUrl, existing.role, adcpVersion, 'Role no longer in declared specialisms');
      result.revoked.push({ role: existing.role, reason: 'Role no longer declared', adcp_version: adcpVersion });
    }
  }

  return result;
}

/**
 * Fan badge issuance out across every supported AdCP version after a
 * compliance run completes.
 *
 * Resolves the membership org, reads the latest per-storyboard statuses
 * from `agent_storyboard_status` (so single-storyboard owner_test runs
 * don't revoke badges for storyboards they didn't touch), and calls
 * `processAgentBadges` per version with that version's storyboard set.
 *
 * Callers (heartbeat, owner_test paths, single-storyboard run) decide
 * separately whether to send a verification-change notification.
 */
export async function runBadgeFanOut(params: {
  complianceDb: ComplianceDatabase;
  agentUrl: string;
  declaredSpecialisms: string[];
}): Promise<BadgeIssuanceResult> {
  const { complianceDb, agentUrl, declaredSpecialisms } = params;
  const aggregate: BadgeIssuanceResult = { issued: [], revoked: [], degraded: [], unchanged: [] };

  if (declaredSpecialisms.length === 0) {
    return aggregate;
  }

  // Resolve membership org for this agent — only orgs with an active
  // API-access tier qualify for badge issuance. processAgentBadges
  // revokes all badges if this returns undefined.
  const orgResult = await query(
    `SELECT mp.workos_organization_id
     FROM member_profiles mp
     JOIN organizations o ON o.workos_organization_id = mp.workos_organization_id
     WHERE mp.agents @> $1::jsonb
       AND o.membership_tier = ANY($2::text[])
       AND o.subscription_status = ANY($3::text[])
     ORDER BY mp.created_at ASC
     LIMIT 1`,
    [
      JSON.stringify([{ url: agentUrl }]),
      [...API_ACCESS_TIERS],
      [...ACTIVE_SUBSCRIPTION_STATUSES],
    ],
  );
  const membershipOrgId = orgResult.rows[0]?.workos_organization_id as string | undefined;

  // Load the latest per-storyboard state from the canonical table. This
  // captures the row that recordComplianceRun() just upserted plus every
  // earlier storyboard's last result — essential for partial runs
  // (single-storyboard owner_test) so unrelated storyboards' badges
  // aren't degraded just because they weren't touched this run.
  const latestStatuses = await complianceDb.getStoryboardStatuses(agentUrl);
  const storyboardStatuses: StoryboardStatusEntry[] = latestStatuses.map(s => ({
    storyboard_id: s.storyboard_id,
    status: s.status as StoryboardStatus,
    steps_passed: s.steps_passed,
    steps_total: s.steps_total,
  }));

  // overallPassing reflects whether *every* storyboard the agent has
  // ever run is currently passing. processAgentBadges does not branch
  // on this today but accepts it for symmetry; keep it accurate.
  const overallPassing = storyboardStatuses.length > 0 &&
    storyboardStatuses.every(s => s.status === 'passing');

  for (const adcpVersion of SUPPORTED_BADGE_VERSIONS) {
    // Per-version try/catch matches the heartbeat behavior: a failure
    // at one version must not poison another version's issuance, and a
    // persistent failure must surface via the system-error channel
    // instead of disappearing into a non-fatal warn.
    try {
      const versionStoryboardIds = new Set(getStoryboardIdsForVersion(adcpVersion));
      const versionScoped = storyboardStatuses.filter(s => versionStoryboardIds.has(s.storyboard_id));

      const versionResult = await processAgentBadges(
        complianceDb,
        agentUrl,
        declaredSpecialisms,
        versionScoped,
        overallPassing,
        membershipOrgId,
        adcpVersion,
      );

      for (const issued of versionResult.issued) aggregate.issued.push(issued);
      for (const revoked of versionResult.revoked) aggregate.revoked.push(revoked);
      for (const degraded of versionResult.degraded) aggregate.degraded.push(degraded);
      for (const unchanged of versionResult.unchanged) aggregate.unchanged.push(unchanged);
    } catch (versionError) {
      const errorMessage = versionError instanceof Error ? versionError.message : String(versionError);
      logger.error(
        { versionError, agentUrl, adcpVersion },
        'Badge processing failed for one AdCP version — continuing with remaining versions',
      );
      notifySystemError({
        source: 'compliance-badge-issuance',
        errorMessage: `Per-version badge processing failed for ${agentUrl} at AdCP ${adcpVersion}: ${errorMessage}`,
      });
    }
  }

  return aggregate;
}
