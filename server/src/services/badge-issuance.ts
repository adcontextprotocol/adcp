/**
 * Badge issuance service — called after compliance runs to issue/revoke/degrade
 * AAO Verified badges based on storyboard results.
 */

import { ComplianceDatabase, type BadgeRole, type StoryboardStatusEntry } from '../db/compliance-db.js';
import { deriveVerificationStatus } from '../addie/services/compliance-testing.js';
import { signVerificationToken, isTokenSigningEnabled } from './verification-token.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'badge-issuance' });

export interface BadgeIssuanceResult {
  issued: Array<{ role: BadgeRole; storyboards: string[] }>;
  revoked: Array<{ role: BadgeRole; reason: string }>;
  degraded: Array<{ role: BadgeRole }>;
  unchanged: Array<{ role: BadgeRole }>;
}

/**
 * Check and update badge status for an agent after a compliance run.
 *
 * Called from the heartbeat job after recordComplianceRun().
 * Uses the agent's storyboard status from the DB to determine eligibility.
 *
 * @param agentUrl - The agent URL
 * @param declaredStoryboards - Storyboard IDs the agent declares (from capabilities or applicable-storyboards)
 * @param storyboardStatuses - Latest storyboard results from the compliance run
 * @param overallPassing - Whether the overall compliance run was passing
 * @param membershipOrgId - The org that owns the agent (for membership gating)
 */
export async function processAgentBadges(
  complianceDb: ComplianceDatabase,
  agentUrl: string,
  declaredStoryboards: string[],
  storyboardStatuses: StoryboardStatusEntry[],
  overallPassing: boolean,
  membershipOrgId?: string,
): Promise<BadgeIssuanceResult> {
  const result: BadgeIssuanceResult = { issued: [], revoked: [], degraded: [], unchanged: [] };

  if (declaredStoryboards.length === 0) {
    return result;
  }

  const verification = deriveVerificationStatus(declaredStoryboards, storyboardStatuses);
  const existingBadges = await complianceDb.getBadgesForAgent(agentUrl);
  const existingByRole = new Map(existingBadges.map(b => [b.role, b]));

  for (const roleResult of verification.roles) {
    const existing = existingByRole.get(roleResult.role);

    if (roleResult.verified) {
      // Agent qualifies for this role badge
      if (!membershipOrgId) {
        // No membership — can't issue badge, but don't revoke existing ones immediately
        if (existing) {
          result.unchanged.push({ role: roleResult.role });
        }
        continue;
      }

      // Sign a JWT token if keys are configured
      let token: string | undefined;
      let tokenExpiresAt: Date | undefined;
      if (isTokenSigningEnabled()) {
        const signed = await signVerificationToken({
          agent_url: agentUrl,
          role: roleResult.role,
          verified_storyboards: roleResult.storyboards,
        });
        if (signed) {
          token = signed.token;
          tokenExpiresAt = signed.expires_at;
        }
      }

      await complianceDb.upsertBadge({
        agent_url: agentUrl,
        role: roleResult.role,
        verified_storyboards: roleResult.storyboards,
        verification_token: token,
        token_expires_at: tokenExpiresAt,
        membership_org_id: membershipOrgId,
      });

      if (!existing) {
        result.issued.push({ role: roleResult.role, storyboards: roleResult.storyboards });
        logger.info({ agentUrl, role: roleResult.role, storyboards: roleResult.storyboards }, 'Badge issued');
      } else {
        result.unchanged.push({ role: roleResult.role });
      }
    } else if (existing) {
      // Agent had a badge but is no longer passing all storyboards for this role
      if (existing.status === 'active') {
        // First failure — degrade (48-hour grace)
        await complianceDb.degradeBadge(agentUrl, roleResult.role);
        result.degraded.push({ role: roleResult.role });
        logger.info({ agentUrl, role: roleResult.role, failing: roleResult.failing }, 'Badge degraded');
      } else if (existing.status === 'degraded') {
        // Already degraded — check if 48 hours have passed
        const degradedAt = existing.updated_at;
        const hoursSinceDegraded = (Date.now() - degradedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceDegraded >= 48) {
          await complianceDb.revokeBadge(agentUrl, roleResult.role, `Storyboards failing for 48+ hours: ${roleResult.failing.join(', ')}`);
          result.revoked.push({ role: roleResult.role, reason: `Failing storyboards: ${roleResult.failing.join(', ')}` });
          logger.info({ agentUrl, role: roleResult.role, failing: roleResult.failing }, 'Badge revoked after 48h grace');
        } else {
          result.unchanged.push({ role: roleResult.role });
        }
      }
    }
  }

  // Check for badges on roles that are no longer in the declared storyboards
  const activeRoles = new Set(verification.roles.map(r => r.role));
  for (const existing of existingBadges) {
    if (!activeRoles.has(existing.role)) {
      await complianceDb.revokeBadge(agentUrl, existing.role, 'Role no longer in declared storyboards');
      result.revoked.push({ role: existing.role, reason: 'Role no longer declared' });
    }
  }

  return result;
}
