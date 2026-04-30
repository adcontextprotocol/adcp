/**
 * Badge issuance service — called after compliance runs to issue/revoke/degrade
 * AAO Verified badges based on specialism results.
 */

import { ComplianceDatabase, DEFAULT_BADGE_ADCP_VERSION, type BadgeRole, type StoryboardStatusEntry } from '../db/compliance-db.js';
import { deriveVerificationStatus } from '../addie/services/compliance-testing.js';
import { signVerificationToken, isTokenSigningEnabled } from './verification-token.js';
import { isVerificationMode, type VerificationMode } from './adcp-taxonomy.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'badge-issuance' });

export interface BadgeIssuanceResult {
  issued: Array<{ role: BadgeRole; specialisms: string[] }>;
  revoked: Array<{ role: BadgeRole; reason: string }>;
  degraded: Array<{ role: BadgeRole }>;
  unchanged: Array<{ role: BadgeRole }>;
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
      result.revoked.push({ role: existing.role, reason: 'Membership lapsed' });
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
        result.issued.push({ role: roleResult.role, specialisms: roleResult.specialisms });
        logger.info({ agentUrl, role: roleResult.role, adcpVersion, specialisms: roleResult.specialisms }, 'Badge issued');
      } else {
        result.unchanged.push({ role: roleResult.role });
      }
    } else if (existing) {
      if (existing.status === 'active') {
        await complianceDb.degradeBadge(agentUrl, roleResult.role, adcpVersion);
        result.degraded.push({ role: roleResult.role });
        logger.info({ agentUrl, role: roleResult.role, adcpVersion, failing: roleResult.failing }, 'Badge degraded');
      } else if (existing.status === 'degraded') {
        const degradedAt = existing.updated_at;
        const hoursSinceDegraded = (Date.now() - degradedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceDegraded >= 48) {
          await complianceDb.revokeBadge(agentUrl, roleResult.role, adcpVersion, `Specialisms failing for 48+ hours: ${roleResult.failing.join(', ')}`);
          result.revoked.push({ role: roleResult.role, reason: `Failing specialisms: ${roleResult.failing.join(', ')}` });
          logger.info({ agentUrl, role: roleResult.role, adcpVersion, failing: roleResult.failing }, 'Badge revoked after 48h grace');
        } else {
          result.unchanged.push({ role: roleResult.role });
        }
      }
    }
  }

  // Revoke badges on roles that are no longer declared
  const activeRoles = new Set(verification.roles.map(r => r.role));
  for (const existing of existingBadges) {
    if (!activeRoles.has(existing.role)) {
      await complianceDb.revokeBadge(agentUrl, existing.role, adcpVersion, 'Role no longer in declared specialisms');
      result.revoked.push({ role: existing.role, reason: 'Role no longer declared' });
    }
  }

  return result;
}
