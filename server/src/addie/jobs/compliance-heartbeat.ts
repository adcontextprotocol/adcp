/**
 * Compliance Heartbeat Job
 *
 * Runs comply() from @adcp/client against registered agents on a schedule.
 * Updates compliance status and triggers notifications on status transitions.
 */

import {
  comply,
  complianceResultToDbInput,
  classifyCapabilityResolutionError,
  presentCapabilityResolutionError,
  type ComplyOptions,
} from '../services/compliance-testing.js';
import { ComplianceDatabase, type LifecycleStage } from '../../db/compliance-db.js';
import { query } from '../../db/client.js';
import { notifyComplianceChange } from '../../notifications/compliance.js';
import { notifySystemError } from '../error-notifier.js';
import { logger as baseLogger } from '../../logger.js';
import { logOutboundRequest } from '../../db/outbound-log-db.js';
import { AAO_UA_COMPLIANCE } from '../../config/user-agents.js';
import { adaptAuthForSdk } from '../../services/sdk-auth-adapter.js';

const logger = baseLogger.child({ module: 'compliance-heartbeat' });
const complianceDb = new ComplianceDatabase();

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

  // Mark agents as in-progress to prevent concurrent pickup by overlapping runs
  const urls = agentsDue.map(a => a.agent_url);
  await query(
    `INSERT INTO agent_compliance_status (agent_url, status, last_checked_at)
     SELECT unnest($1::text[]), 'unknown', NOW()
     ON CONFLICT (agent_url) DO UPDATE SET last_checked_at = NOW()`,
    [urls],
  );

  for (const agent of agentsDue) {
    const startTime = Date.now();
    try {
      const auth = await complianceDb.resolveOwnerAuth(agent.agent_url);
      const sdkAuth = await adaptAuthForSdk(auth, { tokenEndpointLabel: `heartbeat:${agent.agent_url}` });

      const complyOptions: ComplyOptions = {
        test_session_id: `heartbeat-${Date.now()}`,
        timeout_ms: 60_000,
        auth: sdkAuth,
        userAgent: AAO_UA_COMPLIANCE,
      };

      const complianceResult = await comply(agent.agent_url, complyOptions);

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
      const { statusTransition, storyboardStatuses } = await complianceDb.recordComplianceRun(dbInput);

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
        await complianceDb.recordComplianceRun({
          agent_url: agent.agent_url,
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
          dry_run: true,
        });
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
