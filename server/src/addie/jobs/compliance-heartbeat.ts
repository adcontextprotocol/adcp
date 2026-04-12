/**
 * Compliance Heartbeat Job
 *
 * Runs comply() from @adcp/client against registered agents on a schedule.
 * Updates compliance status and triggers notifications on status transitions.
 */

import { comply, complianceResultToDbInput, type ComplyOptions, type PlatformType } from '../services/compliance-testing.js';
import { ComplianceDatabase, type LifecycleStage } from '../../db/compliance-db.js';
import { query } from '../../db/client.js';
import { notifyComplianceChange } from '../../notifications/compliance.js';
import { notifySystemError } from '../error-notifier.js';
import { logger as baseLogger } from '../../logger.js';
import { logOutboundRequest } from '../../db/outbound-log-db.js';
import { AAO_UA_COMPLIANCE } from '../../config/user-agents.js';

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
      // Use the owning org's saved credentials from agent_contexts.
      // These are credentials the owner saved when connecting through Addie.
      const auth = await complianceDb.resolveOwnerAuth(agent.agent_url);

      // Pass platform_type for coherence reporting
      const metadata = await complianceDb.getRegistryMetadata(agent.agent_url);
      const platformType = metadata?.platform_type as PlatformType | undefined;

      const complyOptions: ComplyOptions = {
        test_session_id: `heartbeat-${Date.now()}`,
        dry_run: true,
        timeout_ms: 60_000,
        auth,
        userAgent: AAO_UA_COMPLIANCE,
        ...(platformType && { platform_type: platformType }),
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

      // Agent timeouts are expected (slow/unreachable agents) — log at warn, not error
      if (isAgentTimeout) {
        logger.warn({ agentUrl: agent.agent_url }, `Compliance check timed out for agent: ${agent.agent_url}`);
      } else {
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
          headline: isAgentTimeout ? `Timed out: agent did not respond within 60s` : `Unreachable: ${errorMessage}`,
          tracks_json: [],
          tracks_passed: 0,
          tracks_failed: 0,
          tracks_skipped: 0,
          tracks_partial: 0,
          observations_json: [{ category: 'connectivity', severity: isAgentTimeout ? 'warning' : 'error', message: errorMessage }],
          triggered_by: 'heartbeat',
          dry_run: true,
        });
      } catch (recordError) {
        logger.error({ recordError, agentUrl: agent.agent_url }, 'Failed to record compliance failure');
      }

      // Timeouts count as checked (not skipped) — they're a valid result, not a skip
      if (isAgentTimeout) {
        result.checked++;
        result.failed++;
      } else {
        result.skipped++;
      }
    }
  }

  return result;
}
