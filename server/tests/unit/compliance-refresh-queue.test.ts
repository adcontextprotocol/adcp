import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimedComplianceRefreshRequest,
  ComplianceRefreshRequestsDatabase,
} from '../../src/db/compliance-refresh-requests-db.js';
import { ComplianceRefreshQueue } from '../../src/services/compliance-refresh-queue.js';

function claimedRequest(): ClaimedComplianceRefreshRequest {
  const now = new Date();
  return {
    id: randomUUID(),
    agent_url: 'https://agent.example.test/mcp',
    owner_org_id: 'org-test',
    requester_type: 'user',
    requested_by_user_id: 'user-test',
    triggered_by: 'owner_test',
    test_session_id: 'owner-refresh-test',
    status: 'running',
    attempts: 1,
    max_attempts: 2,
    available_at: now,
    lease_owner: 'worker-test',
    lease_token: randomUUID(),
    lease_expires_at: new Date(Date.now() + 60_000),
    heartbeat_at: now,
    last_attempted_at: now,
    probe_result_json: null,
    auth_available: null,
    result_json: null,
    last_error_code: null,
    last_error: null,
    created_at: now,
    started_at: now,
    completed_at: null,
    updated_at: now,
    was_reclaimed: false,
  };
}

describe('ComplianceRefreshQueue', () => {
  it('never persists or logs arbitrary exception codes and messages', async () => {
    const request = claimedRequest();
    const markFailed = vi.fn().mockResolvedValue(true);
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({
        isValid: () => true,
        release: vi.fn().mockResolvedValue(undefined),
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      deferClaim: vi.fn().mockResolvedValue(true),
      requeueAfterFailure: vi.fn().mockResolvedValue(false),
      markSucceeded: vi.fn(),
      markFailed,
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    } as unknown as ComplianceRefreshRequestsDatabase;
    const sentinel = 'Authorization: Bearer SENTINEL_REFRESH_SECRET';
    const queue = new ComplianceRefreshQueue(
      async () => {
        throw Object.assign(new Error(sentinel), { code: `upstream_${sentinel}` });
      },
      db,
      'worker-test',
    );

    await expect(queue.processQueue()).resolves.toMatchObject({ failed: 1 });
    expect(markFailed).toHaveBeenCalledWith(
      request.id,
      request.lease_token,
      'refresh_failed',
      'The compliance refresh failed',
    );
    expect(JSON.stringify(markFailed.mock.calls)).not.toContain('SENTINEL_REFRESH_SECRET');
  });

  it('returns an unexecuted claim when another full suite holds the agent fence', async () => {
    const request = claimedRequest();
    const deferClaim = vi.fn().mockResolvedValue(true);
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue(null),
      deferClaim,
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    } as unknown as ComplianceRefreshRequestsDatabase;
    const execute = vi.fn();

    const result = await new ComplianceRefreshQueue(execute, db, 'worker-test').processQueue();

    expect(result).toMatchObject({ lostLease: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(deferClaim).toHaveBeenCalledWith(request.id, request.lease_token);
  });

  it('requeues a saved run when badge fan-out needs to be replayed', async () => {
    const request = claimedRequest();
    const requeueAfterFailure = vi.fn().mockResolvedValue(true);
    const markFailed = vi.fn();
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({
        isValid: () => true,
        release: vi.fn().mockResolvedValue(undefined),
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      requeueAfterFailure,
      markSucceeded: vi.fn(),
      markFailed,
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    } as unknown as ComplianceRefreshRequestsDatabase;
    const queue = new ComplianceRefreshQueue(
      async () => {
        throw Object.assign(new Error('Badge fan-out failed'), { code: 'badge_update_failed' });
      },
      db,
      'worker-test',
    );

    await expect(queue.processQueue()).resolves.toMatchObject({ failed: 1 });
    expect(requeueAfterFailure).toHaveBeenCalledWith(
      request.id,
      request.lease_token,
      'badge_update_failed',
      'The compliance evidence was saved but badge state could not be updated',
    );
    expect(markFailed).not.toHaveBeenCalled();
  });
});
