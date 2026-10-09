import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getComplianceRun,
  claimJobs,
  completeJob,
  retryJob,
  runBadgeFanOut,
} = vi.hoisted(() => ({
  getComplianceRun: vi.fn(),
  claimJobs: vi.fn(),
  completeJob: vi.fn(),
  retryJob: vi.fn(),
  runBadgeFanOut: vi.fn(),
}));

vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    getComplianceRun = getComplianceRun;
  },
}));

vi.mock('../../src/db/verification-profile-db.js', () => ({
  claimGradingProfileProjectionJobs: claimJobs,
  completeGradingProfileProjectionJob: completeJob,
  retryGradingProfileProjectionJob: retryJob,
}));

vi.mock('../../src/services/badge-issuance.js', () => ({ runBadgeFanOut }));

import { runVerificationProfileProjectionJob } from '../../src/addie/jobs/verification-profile-projection.js';

const job = {
  agent_url: 'https://seller.example.test/mcp',
  role: 'media-buy' as const,
  adcp_version: '3.1',
  selection_revision: '4',
  source_run_id: 'run-4',
  assessment_id: 'assessment-4',
  attempts: 1,
};

describe('verification profile projection job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimJobs.mockResolvedValue([job]);
    getComplianceRun.mockResolvedValue({
      agent_profile_json: {
        specialisms: ['sales-non-guaranteed'],
        adcp_supported_versions: ['3.1'],
      },
    });
    runBadgeFanOut.mockResolvedValue({ issued: [], revoked: [], degraded: [], unchanged: [] });
  });

  it('replays only the selected role and release from immutable stored evidence', async () => {
    await expect(runVerificationProfileProjectionJob()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
    });
    expect(runBadgeFanOut).toHaveBeenCalledWith(expect.objectContaining({
      agentUrl: job.agent_url,
      runId: job.source_run_id,
      adcpVersions: ['3.1'],
      roles: ['media-buy'],
      declaredSpecialisms: ['sales-non-guaranteed'],
      supportedVersions: ['3.1'],
      throwOnFailure: true,
    }));
    expect(completeJob).toHaveBeenCalledWith({
      agentUrl: job.agent_url,
      role: job.role,
      adcpVersion: job.adcp_version,
      selectionRevision: job.selection_revision,
    });
    expect(retryJob).not.toHaveBeenCalled();
  });

  it('defers a failed projection without starting a new compliance run', async () => {
    runBadgeFanOut.mockRejectedValueOnce(new Error('write failed'));

    await expect(runVerificationProfileProjectionJob()).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
    });
    expect(retryJob).toHaveBeenCalledWith(job, expect.objectContaining({ message: 'write failed' }));
    expect(completeJob).not.toHaveBeenCalled();
  });
});
