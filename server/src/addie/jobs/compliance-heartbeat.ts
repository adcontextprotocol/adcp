import { complianceRunProvenance } from '../../compliance/run-provenance.js';
import { isAuthoritativeComplianceRun } from '../../compliance/run-publication.js';
import { withStoryboardSkipDetails } from '../../compliance/storyboard-skip-details.js';
/**
 * Compliance Heartbeat Job
 *
 * Runs comply() from @adcp/sdk against registered agents on a schedule.
 * Updates compliance status and triggers notifications on status transitions.
 */

import { LIBRARY_VERSION } from '@adcp/sdk';
import {
  comply,
  complianceResultToDbInput,
  classifyCapabilityResolutionError,
  presentCapabilityResolutionError,
  badgeEligibleVersionsForTargetSelection,
  hasTrustworthyComplianceTarget,
  HOSTED_TARGET_DISCOVERY_TIMEOUT_MS,
  selectComplianceTargetForAgentSelection,
  selectedComplianceTargetMatchesObservedProfile,
  type ComplyOptions,
  type ComplianceTargetSelection,
  type ComplianceResult,
} from '../services/compliance-testing.js';
import { ComplianceDatabase, type LifecycleStage } from '../../db/compliance-db.js';
import { query } from '../../db/client.js';
import {
  ComplianceRefreshRequestsDatabase,
  COMPLIANCE_HEARTBEAT_GLOBAL_RUNNING_LIMIT,
} from '../../db/compliance-refresh-requests-db.js';
import { notifyComplianceChange, notifyVerificationChange } from '../../notifications/compliance.js';
import { notifySystemError } from '../error-notifier.js';
import { logger as baseLogger } from '../../logger.js';
import { logOutboundRequest } from '../../db/outbound-log-db.js';
import { AAO_UA_COMPLIANCE } from '../../config/user-agents.js';
import { revokeUnsupportedPublicBadges, runBadgeFanOut } from '../../services/badge-issuance.js';
import { adaptAuthForSdk } from '../../services/sdk-auth-adapter.js';
import {
  pruneVerificationProfileShadowAssessments,
  recordVerificationProfileShadowAssessment,
} from '../../db/verification-profile-shadow-db.js';
import {
  deriveVerificationProfileShadowAssessment,
  VERIFICATION_PROFILE_SHADOW_POLICY_VERSION,
} from '../../services/verification-profile-shadow.js';
import { deriveVerificationProfileRoleAssessments } from '../../services/verification-profile-assessment.js';
import {
  hostedComplianceTarget,
  HOSTED_COMPLIANCE_OVERRUN_MS,
  HOSTED_EXTENDED_COMPLIANCE_TIMEOUT_MS,
  HOSTED_FULL_COMPLIANCE_TIMEOUT_MS,
} from '../../services/hosted-compliance-version.js';

const logger = baseLogger.child({ module: 'compliance-heartbeat' });
const complianceDb = new ComplianceDatabase();
const complianceRefreshDb = new ComplianceRefreshRequestsDatabase();
const fallbackComplianceTarget = hostedComplianceTarget();

interface HeartbeatOptions {
  limit?: number;
  /** Include the bounded admin status snapshot used by the scheduled worker. */
  includeOperationalDiagnostics?: boolean;
}

export interface HeartbeatResult {
  checked: number;
  passed: number;
  failed: number;
  skipped: number;
  diagnostics?: {
    eligibleBacklog: number;
    selectedAgents: string[];
    runsRecorded: number;
    skipReasons: HeartbeatSkipReasons;
    requestedComplianceTarget: string;
    complianceBundleVersion: string;
    sdkVersion: string;
  };
}

/**
 * An inconclusive target or audit-only run is a completed per-agent attempt,
 * not a worker failure. Escalate only when every selected agent was blocked by
 * setup, execution-fence, or persistence errors before any run could be recorded.
 */
export function assertComplianceHeartbeatOperationalProgress(result: HeartbeatResult): void {
  const diagnostics = result.diagnostics;
  if (!diagnostics || diagnostics.selectedAgents.length === 0 || result.checked > 0 || diagnostics.runsRecorded > 0) {
    return;
  }

  const { skipReasons } = diagnostics;
  const blockedByWorker = skipReasons.pre_target_error + skipReasons.execution_fence_lost + skipReasons.agent_error;
  if (blockedByWorker !== diagnostics.selectedAgents.length) return;

  throw new Error(
    `Compliance heartbeat could not process any of ${diagnostics.selectedAgents.length} selected agents`
    + ` (backlog=${diagnostics.eligibleBacklog}, runs_recorded=${diagnostics.runsRecorded},`
    + ` skips=${JSON.stringify(skipReasons)})`,
  );
}

interface HeartbeatSkipReasons {
  execution_fence_busy: number;
  execution_fence_lost: number;
  target_unconfirmed: number;
  target_superseded: number;
  audit_only: number;
  pre_target_error: number;
  agent_error: number;
}

type PendingShadowAssessment = Parameters<typeof recordVerificationProfileShadowAssessment>[0];

async function pruneShadowLedgerBestEffort(): Promise<void> {
  try {
    const pruned = await pruneVerificationProfileShadowAssessments();
    if (pruned > 0) {
      logger.info({ pruned }, 'Pruned expired verification profile shadow assessments');
    }
  } catch (pruneError) {
    logger.error(
      { pruneError },
      'Verification profile shadow retention cleanup failed without affecting public compliance',
    );
  }
}

export async function runComplianceHeartbeatJob(
  options: HeartbeatOptions = {},
  signal?: AbortSignal,
): Promise<HeartbeatResult> {
  signal?.throwIfAborted();
  const limit = options.limit ?? 6;
  const result: HeartbeatResult = { checked: 0, passed: 0, failed: 0, skipped: 0 };
  const skipReasons: HeartbeatSkipReasons = {
    execution_fence_busy: 0,
    execution_fence_lost: 0,
    target_unconfirmed: 0,
    target_superseded: 0,
    audit_only: 0,
    pre_target_error: 0,
    agent_error: 0,
  };

  const agentsDue = await complianceDb.getAgentsDueForCheck(limit);
  // COUNT(*) OVER() is calculated before LIMIT in the due-agent query. Keep a
  // defensive fallback for tests and rolling deploys where an older database
  // result shape may briefly coexist with this worker build.
  const eligibleBacklog = Number(agentsDue[0]?.eligible_backlog ?? agentsDue.length);
  logger.debug(
    { selectedCount: agentsDue.length, eligibleBacklog, batchLimit: limit },
    'Agents due for compliance check',
  );
  const batchStartedAt = Date.now();
  const pendingShadowAssessments: PendingShadowAssessment[] = [];
  let runsRecorded = 0;

  // Mark selected agents in progress before concurrent processing. The lock
  // covers the worst-case number of waves, including target discovery, so an
  // overlapping worker cannot select agents awaiting a local suite slot.
  const selectedUrls = agentsDue.map(a => a.agent_url);
  // Each agent has two bounded capability pre-discoveries: target selection,
  // then hosted auth defaults inside comply(). Account for both explicitly so
  // the lock remains valid for the documented worst case.
  const perAgentBudgetMs = HOSTED_EXTENDED_COMPLIANCE_TIMEOUT_MS
    + HOSTED_COMPLIANCE_OVERRUN_MS + (2 * HOSTED_TARGET_DISCOVERY_TIMEOUT_MS);
  const waves = Math.ceil(selectedUrls.length / COMPLIANCE_HEARTBEAT_GLOBAL_RUNNING_LIMIT);
  const lockUntil = new Date(Date.now() + waves * perAgentBudgetMs + 300_000);
  let claimedUrls = new Set<string>();
  if (selectedUrls.length > 0) {
    const claimed = await query<{ agent_url: string }>(
      `INSERT INTO agent_registry_metadata (agent_url, next_compliance_check_at)
       SELECT unnest($1::text[]), $2::timestamptz
       ON CONFLICT (agent_url) DO UPDATE SET next_compliance_check_at = EXCLUDED.next_compliance_check_at
       WHERE agent_registry_metadata.next_compliance_check_at IS NULL
          OR agent_registry_metadata.next_compliance_check_at < NOW()
       RETURNING agent_url`,
      [selectedUrls, lockUntil],
    );
    claimedUrls = new Set(claimed.rows.map(row => row.agent_url));
  }
  const claimedAgents = agentsDue.filter(agent => claimedUrls.has(agent.agent_url));
  const urls = claimedAgents.map(agent => agent.agent_url);

  const processAgent = async (agent: (typeof agentsDue)[number]): Promise<void> => {
    signal?.throwIfAborted();
    const executionFence = await complianceRefreshDb.acquireHeartbeatExecutionFence(agent.agent_url);
    if (!executionFence) {
      await complianceDb.deferComplianceCheckAfterContention(agent.agent_url, lockUntil);
      result.skipped++;
      skipReasons.execution_fence_busy++;
      logger.debug(
        { agentUrl: agent.agent_url },
        'Compliance heartbeat skipped because another full suite is running',
      );
      return;
    }
    const startTime = Date.now();
    let assessmentTimeoutMs = HOSTED_FULL_COMPLIANCE_TIMEOUT_MS;
    let credentialOrgId: string | null = null;
    const assertExecutionFence = () => {
      if (!executionFence.isValid()) {
        throw Object.assign(new Error('Compliance heartbeat execution fence was lost'), {
          code: 'execution_fence_lost',
        });
      }
    };
    let runTarget = fallbackComplianceTarget;
    let runTargetSelection: ComplianceTargetSelection = {
      target: fallbackComplianceTarget,
      confirmed: false,
      source: 'default',
    };
    try {
      const previousAttempt = await complianceDb.getLatestComplianceAttempt(agent.agent_url, null);
      if (previousAttempt?.completeness === 'timed_out'
        || (previousAttempt?.completeness === 'complete'
          && (previousAttempt.total_duration_ms ?? 0) >= HOSTED_FULL_COMPLIANCE_TIMEOUT_MS * 0.8)) {
        assessmentTimeoutMs = HOSTED_EXTENDED_COMPLIANCE_TIMEOUT_MS;
      }
      const auth = await complianceDb.resolveOwnerAuth(agent.agent_url, undefined, orgId => {
        credentialOrgId = orgId;
      });
      const sdkAuth = await adaptAuthForSdk(auth, { tokenEndpointLabel: `heartbeat:${agent.agent_url}` });

      // adcp#6632 / adcp-client#2639 — distribute coverage across
      // budget-limited runs: rotate the storyboard starting point by the
      // persisted per-agent run count, so consecutive `timeout_ms`-truncated
      // heartbeats stop re-grading the same prefix while tail tracks
      // (canonical-formats, package-selector) are never reached. The SDK
      // applies the offset modulo the runnable count and ignores the option
      // when it predates 2639 — safe across SDK versions.
      const storyboardStartOffset = await complianceDb.countComplianceRuns(agent.agent_url);
      const hardDeadline = AbortSignal.timeout(assessmentTimeoutMs + HOSTED_COMPLIANCE_OVERRUN_MS);
      const complyOptions: ComplyOptions & { storyboard_start_offset?: number } = {
        test_session_id: `heartbeat-${Date.now()}`,
        timeout_ms: assessmentTimeoutMs,
        auth: sdkAuth,
        userAgent: AAO_UA_COMPLIANCE,
        storyboard_start_offset: storyboardStartOffset,
        signal: signal ? AbortSignal.any([signal, hardDeadline]) : hardDeadline,
      };
      const seededSupportedVersions = await complianceDb.getLastKnownSupportedVersions(agent.agent_url);

      runTargetSelection = await selectComplianceTargetForAgentSelection(
        agent.agent_url,
        complyOptions,
        fallbackComplianceTarget,
        'canonical',
        seededSupportedVersions,
      );
      if (!hasTrustworthyComplianceTarget(runTargetSelection)) {
        logger.warn(
          { agentUrl: agent.agent_url, seededSupportedVersions },
          'Compliance heartbeat skipped because no trustworthy target could be selected',
        );
        await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url, { exponentialBackoff: true });
        result.skipped++;
        skipReasons.target_unconfirmed++;
        return;
      }
      runTarget = runTargetSelection.target;
      assertExecutionFence();
      const complianceResult = await comply(agent.agent_url, complyOptions, runTarget);
      assertExecutionFence();
      if (!selectedComplianceTargetMatchesObservedProfile(runTargetSelection, complianceResult.agent_profile)) {
        logger.warn(
          {
            agentUrl: agent.agent_url,
            selectedTarget: runTarget.requested,
            observedSupportedVersions: complianceResult.agent_profile?.adcp_supported_versions,
          },
          'Compliance heartbeat skipped because the completed run superseded its selected target',
        );
        await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url, { exponentialBackoff: true });
        result.skipped++;
        skipReasons.target_superseded++;
        return;
      }

      logOutboundRequest({
        agent_url: agent.agent_url,
        request_type: 'compliance',
        user_agent: AAO_UA_COMPLIANCE,
        response_time_ms: Date.now() - startTime,
        success: true,
      });

      const dbInput = withStoryboardSkipDetails(complianceResultToDbInput(
        complianceResult,
        agent.agent_url,
        agent.lifecycle_stage as LifecycleStage,
        'heartbeat',
      ), complianceResult);
      dbInput.dry_run = false;
      dbInput.triggered_org_id = credentialOrgId;
      if (isAuthoritativeComplianceRun(dbInput)) {
        dbInput.grading_profile_assessments = deriveVerificationProfileRoleAssessments({
          result: complianceResult,
          lifecycleStage: agent.lifecycle_stage as LifecycleStage,
          requestedComplianceTarget: dbInput.requested_compliance_target,
          storyboardStatuses: dbInput.storyboard_statuses ?? [],
        });
      }
      assertExecutionFence();
      const { run, statusTransition, storyboardStatuses } = await complianceDb.recordComplianceRun(dbInput);
      runsRecorded++;
      assertExecutionFence();

      if (!isAuthoritativeComplianceRun(dbInput)) {
        await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url, { exponentialBackoff: true });
        result.skipped++;
        skipReasons.audit_only++;
        logger.info({ agentUrl: agent.agent_url, runId: run.id, completeness: dbInput.completeness },
          'Recorded audit-only compliance evidence; authoritative grade and badges preserved');
        return;
      }

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
          assertExecutionFence();
          const badgeResult = await runBadgeFanOut({
            complianceDb,
            agentUrl: agent.agent_url,
            declaredSpecialisms,
            runId: run.id,
            adcpVersions: badgeEligibleAdcpVersions,
            supportedVersions: complianceResult.agent_profile?.adcp_supported_versions ?? runTargetSelection.supportedVersions,
          });
          assertExecutionFence();

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
          assertExecutionFence();
          const badgeResult = await revokeUnsupportedPublicBadges({
            complianceDb,
            agentUrl: agent.agent_url,
            supportedVersions: complianceResult.agent_profile?.adcp_supported_versions ?? runTargetSelection.supportedVersions,
            sourceRunId: run.id,
          });
          assertExecutionFence();
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

      // Derivation is pure and queued only after every public status,
      // notification, and badge action for this agent has completed. Database
      // reads/writes are deferred until the entire public batch is finished.
      try {
        pendingShadowAssessments.push({
          sourceRunId: run.id,
          agentUrl: agent.agent_url,
          lifecycleStage: agent.lifecycle_stage as LifecycleStage,
          adcpVersion: dbInput.adcp_version,
          assessment: deriveVerificationProfileShadowAssessment(
            complianceResult,
            agent.lifecycle_stage as LifecycleStage,
            dbInput.overall_status,
          ),
        });
      } catch (shadowError) {
        logger.error(
          { shadowError, agentUrl: agent.agent_url, sourceRunId: run.id },
          'Verification profile shadow derivation failed without affecting public compliance',
        );
      }
    } catch (error) {
      // A scheduler timeout is a batch-level cancellation, not evidence about
      // the current agent. Let the job fail after the finally block releases
      // its execution fence instead of recording a false agent failure and
      // continuing through the rest of the batch with an aborted transport.
      signal?.throwIfAborted();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (error && typeof error === 'object' && 'code' in error && error.code === 'execution_fence_lost') {
        logger.warn(
          { agentUrl: agent.agent_url },
          'Compliance heartbeat stopped after losing the shared execution fence',
        );
        await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url);
        result.skipped++;
        skipReasons.execution_fence_lost++;
        return;
      }

      // Errors before a compatible target is selected are infrastructure or
      // discovery failures, not evidence that the agent failed compliance.
      // Never let the catch path turn the platform default into a canonical
      // public verdict. Best-effort lock release preserves a concurrent owner
      // refresh via the compare-and-set predicate in the database method.
      if (!hasTrustworthyComplianceTarget(runTargetSelection)) {
        logger.warn(
          { agentUrl: agent.agent_url, err: error },
          'Compliance heartbeat skipped after target selection remained inconclusive',
        );
        try {
          await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url);
        } catch (deferError) {
          logger.error(
            { agentUrl: agent.agent_url, deferError },
            'Failed to defer compliance heartbeat after inconclusive target selection',
          );
        }
        result.skipped++;
        skipReasons.pre_target_error++;
        return;
      }

      const isAgentTimeout = /timed?\s*out/i.test(errorMessage);
      const isSavedAuthConfigError = /step\.auth\.basic\.username must be a non-empty string/i.test(errorMessage);
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
        headline = `Timed out: assessment did not complete within ${assessmentTimeoutMs / 1000}s`;
        observationCategory = 'connectivity';
        observationSeverity = 'warning';
        observationMessage = headline;
        logger.warn({ agentUrl: agent.agent_url }, `Compliance check timed out for agent: ${agent.agent_url}`);
      } else if (isSavedAuthConfigError) {
        headline = 'Saved Basic auth credentials are malformed';
        observationCategory = 'authentication';
        observationSeverity = 'warning';
        observationMessage = 'The saved Basic auth credentials for this agent must include a non-empty username.';
        logger.warn({ agentUrl: agent.agent_url }, 'Compliance check skipped Basic auth due to malformed saved credentials');
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

      // A thrown runner error is incomplete audit evidence, not an authoritative verdict.
      try {
        // Recheck the fence before writing: comply() may have thrown while a
        // concurrent owner refresh invalidated the lock. Without this guard the
        // stale heartbeat failure would race with and overwrite the fresher result.
        assertExecutionFence();
        await complianceDb.recordComplianceRun({
          agent_url: agent.agent_url,
          requested_compliance_target: runTarget.requested,
          adcp_version: runTarget.version,
          runner_capability_version: LIBRARY_VERSION,
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
          triggered_org_id: credentialOrgId,
          dry_run: false,
          completeness: 'not_completed',
          provenance_json: complianceRunProvenance({ adcp_version: runTarget.version, agent_profile: {} as ComplianceResult['agent_profile'] }),
          is_authoritative: false,
          replace_storyboard_statuses: true,
        });
        runsRecorded++;

        await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url, { exponentialBackoff: true });
      } catch (recordError) {
        // Fence loss during failure recording must be handled here directly:
        // we are already inside catch (error), so re-throwing would escape the
        // entire try/catch/finally and reject runComplianceHeartbeatJob() instead
        // of continuing to the next agent. Defer and skip, matching the outer
        // fence-loss handler's behavior.
        if (recordError && typeof recordError === 'object' && 'code' in recordError && recordError.code === 'execution_fence_lost') {
          logger.warn(
            { agentUrl: agent.agent_url },
            'Compliance heartbeat stopped after losing the shared execution fence (during failure recording)',
          );
          await complianceDb.deferComplianceCheckAfterInconclusiveTarget(agent.agent_url);
          result.skipped++;
          skipReasons.execution_fence_lost++;
          return;
        }
        logger.error({ recordError, agentUrl: agent.agent_url }, 'Failed to record compliance failure');
      }

      result.skipped++;
      skipReasons.agent_error++;
    } finally {
      await executionFence.release();
    }
  };

  let nextAgentIndex = 0;
  const failures: unknown[] = [];
  const runWorker = async (): Promise<void> => {
    while (nextAgentIndex < claimedAgents.length && failures.length === 0 && !signal?.aborted) {
      const agent = claimedAgents[nextAgentIndex++];
      try {
        await processAgent(agent);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  const initialMemory = process.memoryUsage();
  const peakMemory = { rssMb: toMb(initialMemory.rss), heapUsedMb: toMb(initialMemory.heapUsed) };
  const sampleMemory = () => {
    const current = process.memoryUsage();
    peakMemory.rssMb = Math.max(peakMemory.rssMb, toMb(current.rss));
    peakMemory.heapUsedMb = Math.max(peakMemory.heapUsedMb, toMb(current.heapUsed));
  };
  const memorySampler = setInterval(sampleMemory, 5_000);
  memorySampler.unref();
  try {
    await Promise.all(Array.from(
      { length: Math.min(COMPLIANCE_HEARTBEAT_GLOBAL_RUNNING_LIMIT, claimedAgents.length) },
      runWorker,
    ));
  } finally {
    clearInterval(memorySampler);
    sampleMemory();
  }
  if (failures.length > 0) {
    logger.warn({ peakMemory, selectedCount: claimedAgents.length }, 'Compliance heartbeat batch stopped before completion');
    throw failures[0];
  }
  signal?.throwIfAborted();

  // Comparison persistence is deliberately outside the public heartbeat loop.
  // It reuses the completed run and has no agent traffic or badge side effects.
  const publicProcessingDurationMs = Date.now() - batchStartedAt;
  const shadowFlushStartedAt = Date.now();
  const shadowStats = {
    candidates: pendingShadowAssessments.length,
    attempted: 0,
    recorded: 0,
    disabled: 0,
    errors: 0,
    total_write_latency_ms: 0,
    max_write_latency_ms: 0,
  };
  for (const pending of pendingShadowAssessments) {
    shadowStats.attempted++;
    const writeStartedAt = Date.now();
    try {
      const recorded = await recordVerificationProfileShadowAssessment(pending);
      if (!recorded) {
        shadowStats.disabled++;
        continue;
      }
      shadowStats.recorded++;
      logger.info(
        {
          agentUrl: pending.agentUrl,
          sourceRunId: pending.sourceRunId,
          policyVersion: pending.assessment.policy_version,
          publicStatus: pending.assessment.current_public_status,
          specStatus: pending.assessment.proposed_spec_status,
          sandboxStatus: pending.assessment.proposed_sandbox_status,
          controllerGapPhases: pending.assessment.controller_gap_phase_count,
        },
        'Recorded observation-only verification profile shadow assessment',
      );
    } catch (shadowError) {
      shadowStats.errors++;
      logger.error(
        { shadowError, agentUrl: pending.agentUrl, sourceRunId: pending.sourceRunId },
        'Verification profile shadow assessment failed without affecting public compliance',
      );
    } finally {
      const writeLatencyMs = Date.now() - writeStartedAt;
      shadowStats.total_write_latency_ms += writeLatencyMs;
      shadowStats.max_write_latency_ms = Math.max(shadowStats.max_write_latency_ms, writeLatencyMs);
    }
  }
  // Emit one aggregate health record for every scheduled heartbeat, including
  // empty queues, without exposing endpoint URLs.
  logger.info(
    {
      publicProcessingDurationMs,
      shadowFlushDurationMs: Date.now() - shadowFlushStartedAt,
      queue: {
        eligibleBacklog,
        selectedCount: claimedAgents.length,
        batchLimit: limit,
      },
      inputs: {
        policyVersion: VERIFICATION_PROFILE_SHADOW_POLICY_VERSION,
        sdkVersion: LIBRARY_VERSION,
        complianceTarget: fallbackComplianceTarget.requested,
        complianceCacheVersion: fallbackComplianceTarget.version,
      },
      outcomes: result,
      peakMemory,
      skipReasons,
      shadow: shadowStats,
    },
    'Compliance heartbeat shadow flush completed after public processing',
  );
  await pruneShadowLedgerBestEffort();

  if (options.includeOperationalDiagnostics) {
    result.diagnostics = {
      eligibleBacklog,
      selectedAgents: urls,
      runsRecorded,
      skipReasons: { ...skipReasons },
      requestedComplianceTarget: fallbackComplianceTarget.requested,
      complianceBundleVersion: fallbackComplianceTarget.version,
      sdkVersion: LIBRARY_VERSION,
    };
  }

  return result;
}
