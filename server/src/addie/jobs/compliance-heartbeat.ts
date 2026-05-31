/**
 * Compliance Heartbeat Job
 *
 * Runs comply() from @adcp/sdk against registered agents on a schedule.
 * Updates compliance status and triggers notifications on status transitions.
 */

import {
  comply,
  complianceResultToDbInput,
  classifyCapabilityResolutionError,
  presentCapabilityResolutionError,
  badgeEligibleVersionsForTargetSelection,
  selectComplianceTargetForAgentSelection,
  type ComplyOptions,
  type ComplianceTargetSelection,
} from '../services/compliance-testing.js';
import { ComplianceDatabase, type LifecycleStage } from '../../db/compliance-db.js';
import { query } from '../../db/client.js';
import { notifyComplianceChange, notifyVerificationChange } from '../../notifications/compliance.js';
import { notifySystemError } from '../error-notifier.js';
import { logger as baseLogger } from '../../logger.js';
import { logOutboundRequest } from '../../db/outbound-log-db.js';
import { AAO_UA_COMPLIANCE } from '../../config/user-agents.js';
import { revokeUnsupportedPublicBadges, runBadgeFanOut } from '../../services/badge-issuance.js';
import { adaptAuthForSdk } from '../../services/sdk-auth-adapter.js';
import {
  hostedComplianceTarget,
} from '../../services/hosted-compliance-version.js';

const logger = baseLogger.child({ module: 'compliance-heartbeat' });
const complianceDb = new ComplianceDatabase();
const fallbackComplianceTarget = hostedComplianceTarget();

interface HeartbeatOptions {
  limit?: number;
}

interface HeartbeatResult {
  checked: number;
  passed: number;
  failed: number;
  skipped: number;
}

export async function runComplianceHeartbeatJob(options: HeartbeatOptions = {}): Promise<HeartbeatResult> {
  const limit = options.limit ?? 10;
  const result: HeartbeatResult = { checked: 0, passed: 0, failed: 0, skipped: 0 };

  const agentsDue = await complianceDb.getAgentsDueForCheck(limit);

  if (agentsDue.length === 0) {
    return result;
  }

  logger.debug({ count: agentsDue.length }, 'Agents due for compliance check');

  // Mark agents as in-progress to prevent concurrent pickup by overlapping runs.
  // Use a 30-minute TTL instead of NOW() so a mid-loop process crash (OOM,
  // Fly restart) re-queues the agent within 30 min rather than waiting the full
  // check_interval (default 12 h). recordComplianceRun() stamps the real
  // last_checked_at on success or failure — this is only a concurrency lock.
  const urls = agentsDue.map(a => a.agent_url);
  await query(
    `INSERT INTO agent_compliance_status (agent_url, status, last_checked_at)
     SELECT unnest($1::text[]), 'unknown', NOW() + INTERVAL '30 minutes'
     ON CONFLICT (agent_url) DO UPDATE SET last_checked_at = NOW() + INTERVAL '30 minutes'`,
    [urls],
  );

  for (const agent of agentsDue) {
    const startTime = Date.now();
    let runTarget = fallbackComplianceTarget;
    let runTargetSelection: ComplianceTargetSelection = { target: fallbackComplianceTarget, confirmed: false };
    try {
      const auth = await complianceDb.resolveOwnerAuth(agent.agent_url);
      const sdkAuth = await adaptAuthForSdk(auth, { tokenEndpointLabel: `heartbeat:${agent.agent_url}` });

      const complyOptions: ComplyOptions = {
        test_session_id: `heartbeat-${Date.now()}`,
        timeout_ms: 60_000,
        auth: sdkAuth,
        userAgent: AAO_UA_COMPLIANCE,
      };

      runTargetSelection = await selectComplianceTargetForAgentSelection(
        agent.agent_url,
        complyOptions,
        fallbackComplianceTarget,
        'canonical',
      );
      runTarget = runTargetSelection.target;
      const complianceResult = await comply(agent.agent_url, complyOptions, runTarget);

      logOutboundRequest({
        agent_url: agent.agent_url,
        request_type: 'compliance',
        user_agent: AAO_UA_COMPLIANCE,
        response_time_ms: Date.now() - startTime,
        success: true,
      });

      const dbInput = complianceResultToDbInput(
        complianceResult,
        agent.agent_url,
        agent.lifecycle_stage as LifecycleStage,
        'heartbeat',
      );
      dbInput.dry_run = false;
      const { run, statusTransition, storyboardStatuses } = await complianceDb.recordComplianceRun(dbInput);

      result.checked++;
      if (dbInput.overall_status === 'passing') {
        result.passed++;
      } else {
        result.failed++;
      }

      // Notify on status transitions
      if (statusTransition) {
        try {
          await notifyComplianceChange({
            agentUrl: agent.agent_url,
            previousStatus: statusTransition.previous,
            currentStatus: statusTransition.current,
            headline: complianceResult.summary.headline,
            tracksJson: dbInput.tracks_json,
            storyboardStatuses,
          });
        } catch (notifyError) {
          logger.error({ notifyError, agentUrl: agent.agent_url }, 'Failed to send compliance notification');
          notifySystemError({
            source: 'compliance-notification',
            errorMessage: `Status transition notification failed for ${agent.agent_url}: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
          });
        }
      }

      // Process AAO Verified badges — fan out per supported AdCP version.
      // Issuance is shared with owner_test and single-storyboard run paths;
      // heartbeat is the only caller that follows it up with a Slack
      // notification, since owner-driven runs already have a chat response.
      const declaredSpecialisms = complianceResult.agent_profile?.specialisms ?? [];
      const badgeEligibleAdcpVersions = [
        ...badgeEligibleVersionsForTargetSelection(runTargetSelection, complianceResult.agent_profile),
      ];

      if (declaredSpecialisms.length > 0 && badgeEligibleAdcpVersions.length > 0) {
        try {
          const badgeResult = await runBadgeFanOut({
            complianceDb,
            agentUrl: agent.agent_url,
            declaredSpecialisms,
            runId: run.id,
            adcpVersions: badgeEligibleAdcpVersions,
          });

          if (badgeResult.issued.length > 0 || badgeResult.revoked.length > 0) {
            try {
              await notifyVerificationChange({
                agentUrl: agent.agent_url,
                issued: badgeResult.issued,
                revoked: badgeResult.revoked,
              });
            } catch (notifyError) {
              logger.error({ notifyError, agentUrl: agent.agent_url }, 'Failed to send verification notification');
            }
          }
        } catch (badgeError) {
          logger.error({ badgeError, agentUrl: agent.agent_url }, 'Badge processing setup failed');
          notifySystemError({
            source: 'compliance-badge-issuance',
            errorMessage: `Badge processing setup failed for ${agent.agent_url}: ${badgeError instanceof Error ? badgeError.message : String(badgeError)}`,
          });
        }
      } else {
        try {
          const badgeResult = await revokeUnsupportedPublicBadges({
            complianceDb,
            agentUrl: agent.agent_url,
            supportedVersions: complianceResult.agent_profile?.adcp_supported_versions ?? runTargetSelection.supportedVersions,
          });
          if (badgeResult.revoked.length > 0) {
            await notifyVerificationChange({
              agentUrl: agent.agent_url,
              issued: [],
              revoked: badgeResult.revoked,
            });
          }
        } catch (badgeError) {
          logger.error({ badgeError, agentUrl: agent.agent_url }, 'Unsupported public badge revocation failed');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isAgentTimeout = /timed?\s*out/i.test(errorMessage);
      const capsError = classifyCapabilityResolutionError(error);

      // Classify failure. Timeouts and capability-config faults are expected
      // per-agent problems, not platform errors — log at warn so observability
      // doesn't alarm on them. The DB `headline` flows into Slack DM titles
      // via notifyComplianceChange, so only sanitized / controlled strings
      // go there (never the raw upstream error message).
      let headline: string;
      let observationCategory: string;
      let observationSeverity: 'warning' | 'error';
      let observationMessage: string;
      if (isAgentTimeout) {
        headline = 'Timed out: agent did not respond within 60s';
        observationCategory = 'connectivity';
        observationSeverity = 'warning';
        observationMessage = headline;
        logger.warn({ agentUrl: agent.agent_url }, `Compliance check timed out for agent: ${agent.agent_url}`);
      } else if (capsError) {
        const presentation = presentCapabilityResolutionError(capsError);
        headline = presentation.headline;
        observationCategory = 'capabilities';
        observationSeverity = 'warning';
        observationMessage = presentation.headline;
        logger.warn({ agentUrl: agent.agent_url, ...presentation.logFields }, presentation.logMsg);
      } else {
        headline = `Unreachable: ${errorMessage}`;
        observationCategory = 'connectivity';
        observationSeverity = 'error';
        observationMessage = errorMessage;
        logger.error({ error, agentUrl: agent.agent_url }, 'Compliance check failed for agent');
      }

      logOutboundRequest({
        agent_url: agent.agent_url,
        request_type: 'compliance',
        user_agent: AAO_UA_COMPLIANCE,
        response_time_ms: Date.now() - startTime,
        success: false,
        error_message: errorMessage,
      });

      // Record failure so stale passing data doesn't persist
      try {
        const badgeEligibleAdcpVersions = [...badgeEligibleVersionsForTargetSelection(runTargetSelection)];
        await complianceDb.recordComplianceRun({
          agent_url: agent.agent_url,
          requested_compliance_target: runTarget.requested,
          adcp_version: runTarget.version,
          lifecycle_stage: agent.lifecycle_stage as LifecycleStage,
          overall_status: 'failing',
          headline,
          tracks_json: [],
          tracks_passed: 0,
          tracks_failed: 0,
          tracks_skipped: 0,
          tracks_partial: 0,
          observations_json: [{ category: observationCategory, severity: observationSeverity, message: observationMessage }],
          triggered_by: 'heartbeat',
          dry_run: false,
          replace_storyboard_statuses: true,
        });

        if (badgeEligibleAdcpVersions.length > 0) {
          const eligibleBadgeVersions = new Set(badgeEligibleAdcpVersions);
          const existingBadges = await complianceDb.getBadgesForAgent(agent.agent_url);
          const revoked = [];
          for (const badge of existingBadges) {
            if (!eligibleBadgeVersions.has(badge.adcp_version)) continue;
            await complianceDb.revokeBadge(
              agent.agent_url,
              badge.role,
              badge.adcp_version,
              'Authoritative compliance run failed before storyboard verification',
            );
            revoked.push({
              role: badge.role,
              reason: 'Authoritative compliance run failed',
              adcp_version: badge.adcp_version,
            });
          }
          if (revoked.length > 0) {
            try {
              await notifyVerificationChange({
                agentUrl: agent.agent_url,
                issued: [],
                revoked,
              });
            } catch (notifyError) {
              logger.error({ notifyError, agentUrl: agent.agent_url }, 'Failed to send verification revocation notification');
            }
          }
        } else if (runTargetSelection.confirmed) {
          const badgeResult = await revokeUnsupportedPublicBadges({
            complianceDb,
            agentUrl: agent.agent_url,
            supportedVersions: runTargetSelection.supportedVersions,
          });
          if (badgeResult.revoked.length > 0) {
            try {
              await notifyVerificationChange({
                agentUrl: agent.agent_url,
                issued: [],
                revoked: badgeResult.revoked,
              });
            } catch (notifyError) {
              logger.error({ notifyError, agentUrl: agent.agent_url }, 'Failed to send verification revocation notification');
            }
          }
        }
      } catch (recordError) {
        logger.error({ recordError, agentUrl: agent.agent_url }, 'Failed to record compliance failure');
      }

      // Timeouts and capability-config faults are valid per-agent results
      // (not skips) — they need to surface in checked/failed so the heartbeat
      // summary reflects reality.
      if (isAgentTimeout || capsError) {
        result.checked++;
        result.failed++;
      } else {
        result.skipped++;
      }
    }
  }

  return result;
}
