import { ComplianceDatabase } from '../../db/compliance-db.js';
import {
  claimGradingProfileProjectionJobs,
  completeGradingProfileProjectionJob,
  retryGradingProfileProjectionJob,
} from '../../db/verification-profile-db.js';
import { runBadgeFanOut } from '../../services/badge-issuance.js';
import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'verification-profile-projection' });

/**
 * Retry exact badge/token projections from immutable stored evidence.
 * This job performs database work only; it never connects to the agent.
 */
export async function runVerificationProfileProjectionJob(options: { limit?: number } = {}): Promise<{
  claimed: number;
  completed: number;
  retried: number;
}> {
  const complianceDb = new ComplianceDatabase();
  const jobs = await claimGradingProfileProjectionJobs(options.limit ?? 20);
  let completed = 0;
  let retried = 0;

  for (const job of jobs) {
    try {
      const source = await complianceDb.getComplianceRun(job.agent_url, job.source_run_id);
      const profile = source?.agent_profile_json ?? {};
      const declaredSpecialisms = Array.isArray(profile.specialisms)
        ? profile.specialisms.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      const supportedVersions = Array.isArray(profile.adcp_supported_versions)
        ? profile.adcp_supported_versions.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      if (!source || declaredSpecialisms.length === 0) {
        throw new Error('Immutable source run is unavailable or has no declared specialisms');
      }
      await runBadgeFanOut({
        complianceDb,
        agentUrl: job.agent_url,
        declaredSpecialisms,
        runId: job.source_run_id,
        adcpVersions: [job.adcp_version],
        supportedVersions,
        roles: [job.role],
        throwOnFailure: true,
      });
      await completeGradingProfileProjectionJob({
        agentUrl: job.agent_url,
        role: job.role,
        adcpVersion: job.adcp_version,
        selectionRevision: job.selection_revision,
      });
      completed += 1;
    } catch (error) {
      await retryGradingProfileProjectionJob(job, error);
      retried += 1;
      logger.warn({ error, agentUrl: job.agent_url, role: job.role }, 'Exact grading projection retry deferred');
    }
  }
  return { claimed: jobs.length, completed, retried };
}
