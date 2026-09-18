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
    requested_by_auth_workos_user_id: 'user-test',
    authorization_fingerprint: '',
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
  it.each(['manual', 'owner_test'] as const)('terminalizes missing provenance for %s without retrying', async (triggeredBy) => {
    const request = { ...claimedRequest(), triggered_by: triggeredBy };
    const release = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn().mockResolvedValue(true);
    const requeueAfterFailure = vi.fn();
    const markSucceeded = vi.fn();
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({ isValid: () => true, release }),
      heartbeat: vi.fn(),
      requeueAfterFailure,
      markSucceeded,
      markFailed,
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    } as unknown as ComplianceRefreshRequestsDatabase;
    const queue = new ComplianceRefreshQueue(async () => {
      throw Object.assign(new Error('untrusted upstream diagnostics'), { code: 'authorization_provenance_missing' });
    }, db, 'worker-test');

    await expect(queue.processQueue()).resolves.toEqual({ claimed: 1, succeeded: 0, failed: 1, lostLease: 0 });
    expect(markFailed).toHaveBeenCalledExactlyOnceWith(
      request.id,
      request.lease_token,
      'authorization_provenance_missing',
      'Authenticated credential provenance is missing; submit a new refresh',
    );
    expect(requeueAfterFailure).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('invalidates late probe continuations before awaiting failure persistence', async () => {
    const request = claimedRequest();
    let releaseFailure!: () => void;
    let failureStarted!: () => void;
    const failureBarrier = new Promise<void>(resolve => { releaseFailure = resolve; });
    const enteredFailure = new Promise<void>(resolve => { failureStarted = resolve; });
    let assertExecutionValid!: () => void;
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({ isValid: () => true, release: vi.fn() }),
      markFailed: vi.fn(async () => { failureStarted(); await failureBarrier; return true; }),
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    };
    const work = new ComplianceRefreshQueue(async (_request, lease) => {
      assertExecutionValid = lease.assertValid;
      throw Object.assign(new Error('Probe timeout'), { code: 'probe_failed' });
    }, db as unknown as ComplianceRefreshRequestsDatabase).processQueue();
    await enteredFailure;
    try {
      expect(assertExecutionValid).toThrow(expect.objectContaining({ code: 'lease_lost' }));
    } finally {
      releaseFailure();
      await work;
    }
    expect(assertExecutionValid).toThrow(expect.objectContaining({ code: 'lease_lost' }));
  });

  it.each([false, true])('requires an atomic completion guard (registered: %s)', async (registered) => {
    const request = claimedRequest();
    const guard = vi.fn().mockRejectedValue(Object.assign(new Error('revoked at the write barrier'), {
      code: 'authorization_revoked',
    }));
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({ isValid: () => true, release: vi.fn() }),
      markSucceeded: vi.fn(async (_id, _token, _result, beforeWrite) => {
        await beforeWrite({});
        return true;
      }),
      requeueAfterFailure: vi.fn().mockResolvedValue(false),
      markFailed: vi.fn().mockResolvedValue(true),
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    };
    await new ComplianceRefreshQueue(async (_request, lease) => {
      if (registered) lease.setCompletionGuard(guard);
      return { online: true };
    }, db as unknown as ComplianceRefreshRequestsDatabase).processQueue();

    expect(db.markFailed).toHaveBeenCalledWith(
      request.id, request.lease_token,
      registered ? 'authorization_revoked' : 'authorization_unavailable', expect.any(String),
    );
    if (registered) expect(guard).toHaveBeenCalledOnce();
    else expect(db.markSucceeded).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves unavailable authorization when retry exhaustion is %s', async (exhausted) => {
    const request = claimedRequest();
    request.attempts = exhausted ? request.max_attempts : 1;
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({
        isValid: () => true,
        release: vi.fn().mockResolvedValue(undefined),
      }),
      requeueAfterFailure: vi.fn().mockResolvedValue(!exhausted),
      markSucceeded: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(true),
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    };
    const queue = new ComplianceRefreshQueue(async () => {
      throw Object.assign(new Error('provider-private-diagnostic'), { code: 'authorization_unavailable' });
    }, db as unknown as ComplianceRefreshRequestsDatabase);

    await queue.processQueue();

    const failure = [request.id, request.lease_token, 'authorization_unavailable', 'Refresh authorization is temporarily unavailable'];
    expect(db.requeueAfterFailure).toHaveBeenCalledWith(...failure);
    if (exhausted) expect(db.markFailed).toHaveBeenCalledWith(...failure);
    else expect(db.markFailed).not.toHaveBeenCalled();
    expect(db.markSucceeded).not.toHaveBeenCalled();
  });

  it.each(['authorization_provenance_missing', 'authorization_revoked'])('never retries confirmed %s', async (code) => {
    const request = claimedRequest();
    const db = {
      claimDue: vi.fn().mockResolvedValue({ requests: [request], terminalizedExpired: 0 }),
      acquireExecutionFence: vi.fn().mockResolvedValue({
        isValid: () => true,
        release: vi.fn().mockResolvedValue(undefined),
      }),
      requeueAfterFailure: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(true),
      deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    };
    await new ComplianceRefreshQueue(async () => {
      throw Object.assign(new Error('private-diagnostic'), { code });
    }, db as unknown as ComplianceRefreshRequestsDatabase).processQueue();
    expect(db.requeueAfterFailure).not.toHaveBeenCalled();
    expect(db.markFailed).toHaveBeenCalledWith(request.id, request.lease_token, code, expect.any(String));
    expect(JSON.stringify(db.markFailed.mock.calls)).not.toContain('private-diagnostic');
  });

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
