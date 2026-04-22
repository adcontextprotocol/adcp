/**
 * Badge issuance service — called after compliance runs to issue/revoke/degrade
 * AAO Verified badges based on specialism results.
 */

import { ComplianceDatabase, type BadgeRole, type StoryboardStatusEntry } from '../db/compliance-db.js';
import { deriveVerificationStatus } from '../addie/services/compliance-testing.js';
import { signVerificationToken, isTokenSigningEnabled } from './verification-token.js';
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
): Promise<BadgeIssuanceResult> {
  const result: BadgeIssuanceResult = { issued: [], revoked: [], degraded: [], unchanged: [] };

  if (declaredSpecialisms.length === 0) {
    return result;
  }

  const verification = deriveVerificationStatus(declaredSpecialisms, storyboardStatuses);
  const existingBadges = await complianceDb.getBadgesForAgent(agentUrl);
  const existingByRole = new Map(existingBadges.map(b => [b.role, b]));

  // If the agent's org no longer has API-access membership, revoke all existing
  // badges. Badge issuance is a public trust signal tied to active membership.
  if (!membershipOrgId) {
    for (const existing of existingBadges) {
      await complianceDb.revokeBadge(agentUrl, existing.role, 'Membership lapsed');
      result.revoked.push({ role: existing.role, reason: 'Membership lapsed' });
      logger.info({ agentUrl, role: existing.role }, 'Badge revoked — membership lapsed');
    }
    return result;
  }

  for (const roleResult of verification.roles) {
    const existing = existingByRole.get(roleResult.role);

    if (roleResult.verified) {

      let token: string | undefined;
      let tokenExpiresAt: Date | undefined;
      if (isTokenSigningEnabled()) {
        const signed = await signVerificationToken({
          agent_url: agentUrl,
          role: roleResult.role,
          verified_specialisms: roleResult.specialisms,
        });
        if (signed) {
          token = signed.token;
          tokenExpiresAt = signed.expires_at;
        }
      }

      await complianceDb.upsertBadge({
        agent_url: agentUrl,
        role: roleResult.role,
        verified_specialisms: roleResult.specialisms,
        verification_token: token,
        token_expires_at: tokenExpiresAt,
        membership_org_id: membershipOrgId,
      });

      if (!existing) {
        result.issued.push({ role: roleResult.role, specialisms: roleResult.specialisms });
        logger.info({ agentUrl, role: roleResult.role, specialisms: roleResult.specialisms }, 'Badge issued');
      } else {
        result.unchanged.push({ role: roleResult.role });
      }
    } else if (existing) {
      if (existing.status === 'active') {
        await complianceDb.degradeBadge(agentUrl, roleResult.role);
        result.degraded.push({ role: roleResult.role });
        logger.info({ agentUrl, role: roleResult.role, failing: roleResult.failing }, 'Badge degraded');
      } else if (existing.status === 'degraded') {
        const degradedAt = existing.updated_at;
        const hoursSinceDegraded = (Date.now() - degradedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceDegraded >= 48) {
          await complianceDb.revokeBadge(agentUrl, roleResult.role, `Specialisms failing for 48+ hours: ${roleResult.failing.join(', ')}`);
          result.revoked.push({ role: roleResult.role, reason: `Failing specialisms: ${roleResult.failing.join(', ')}` });
          logger.info({ agentUrl, role: roleResult.role, failing: roleResult.failing }, 'Badge revoked after 48h grace');
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
      await complianceDb.revokeBadge(agentUrl, existing.role, 'Role no longer in declared specialisms');
      result.revoked.push({ role: existing.role, reason: 'Role no longer declared' });
    }
  }

  return result;
}
