/**
 * Compliance Heartbeat Job
 *
 * Runs comply() from @adcp/client against registered agents on a schedule.
 * Updates compliance status and triggers notifications on status transitions.
 */

import { comply, type ComplyOptions } from '@adcp/client/testing';
import { ComplianceDatabase, type TrackSummaryEntry, type OverallRunStatus, type LifecycleStage } from '../../db/compliance-db.js';
import { query } from '../../db/client.js';
import { notifyComplianceChange } from '../../notifications/compliance.js';
import { notifySystemError } from '../error-notifier.js';
import { logger as baseLogger } from '../../logger.js';

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
    try {
      // Use the owning org's saved credentials from agent_contexts.
      // These are credentials the owner saved when connecting through Addie.
      const auth = await complianceDb.resolveOwnerAuth(agent.agent_url);

      const complyOptions: ComplyOptions = {
        test_session_id: `heartbeat-${Date.now()}`,
        dry_run: true,
        timeout_ms: 60_000,
        auth,
      };

      const complianceResult = await comply(agent.agent_url, complyOptions);

      // Map track results to storage format
      const tracksJson: TrackSummaryEntry[] = complianceResult.tracks.map(t => ({
        track: t.track,
        status: t.status,
        scenario_count: t.scenarios.length,
        passed_count: t.scenarios.filter(s => s.overall_passed).length,
        duration_ms: t.duration_ms,
      }));

      // Derive overall status from track counts
      const { tracks_passed, tracks_failed, tracks_partial } = complianceResult.summary;
      let overallStatus: OverallRunStatus;
      if (tracks_failed === 0 && tracks_partial === 0) {
        overallStatus = 'passing';
      } else if (tracks_passed > 0 || tracks_partial > 0) {
        overallStatus = 'partial';
      } else {
        overallStatus = 'failing';
      }

      const { statusTransition } = await complianceDb.recordComplianceRun({
        agent_url: agent.agent_url,
        lifecycle_stage: agent.lifecycle_stage as LifecycleStage,
        overall_status: overallStatus,
        headline: complianceResult.summary.headline,
        total_duration_ms: complianceResult.total_duration_ms,
        tracks_json: tracksJson,
        tracks_passed: complianceResult.summary.tracks_passed,
        tracks_failed: complianceResult.summary.tracks_failed,
        tracks_skipped: complianceResult.summary.tracks_skipped,
        tracks_partial: complianceResult.summary.tracks_partial,
        agent_profile_json: complianceResult.agent_profile,
        observations_json: complianceResult.observations,
        triggered_by: 'heartbeat',
        dry_run: complianceResult.dry_run,
      });

      result.checked++;
      if (overallStatus === 'passing') {
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
            tracksJson,
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
      logger.error({ error, agentUrl: agent.agent_url }, 'Compliance check failed for agent');

      // Record failure so stale passing data doesn't persist
      try {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await complianceDb.recordComplianceRun({
          agent_url: agent.agent_url,
          lifecycle_stage: agent.lifecycle_stage as LifecycleStage,
          overall_status: 'failing',
          headline: `Unreachable: ${errorMessage}`,
          tracks_json: [],
          tracks_passed: 0,
          tracks_failed: 0,
          tracks_skipped: 0,
          tracks_partial: 0,
          observations_json: [{ category: 'connectivity', severity: 'error', message: errorMessage }],
          triggered_by: 'heartbeat',
          dry_run: true,
        });
      } catch (recordError) {
        logger.error({ recordError, agentUrl: agent.agent_url }, 'Failed to record compliance failure');
      }

      result.skipped++;
    }
  }

  return result;
}
