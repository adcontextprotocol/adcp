import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentQualityEvaluationDatabase,
  OwnedAgentQualityEvaluation,
} from '../../src/db/agent-quality-evaluation-db.js';
import {
  AgentQualityEvaluationLease,
  AgentQualityEvaluationLeaseLostError,
} from '../../src/services/agent-quality-evaluation-lease.js';

describe('agent quality evaluation lease lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createLease(heartbeat: ReturnType<typeof vi.fn>) {
    const db = {
      heartbeat,
      markCompleted: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
    };
    const evaluation = {
      id: 'evaluation-id',
      lease_token: 'lease-token',
      lease_expires_at: new Date(Date.now() + 1_000),
    } as OwnedAgentQualityEvaluation;
    const lease = new AgentQualityEvaluationLease(
      db as unknown as AgentQualityEvaluationDatabase,
      evaluation,
      () => undefined,
      1_000,
      100,
    );
    return { lease, db };
  }

  it('aborts at hard expiry during a database outage and stops renewing', async () => {
    const heartbeat = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const { lease } = createLease(heartbeat);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(AgentQualityEvaluationLeaseLostError);
    const callsAtExpiry = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(heartbeat).toHaveBeenCalledTimes(callsAtExpiry);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not re-arm timers when a heartbeat returns after completion', async () => {
    let resolveHeartbeat!: (expiry: Date) => void;
    const heartbeat = vi.fn().mockImplementation(() => new Promise<Date>(resolve => {
      resolveHeartbeat = resolve;
    }));
    const { lease, db } = createLease(heartbeat);
    await vi.advanceTimersByTimeAsync(100);
    await lease.complete({ authoritative: true });
    resolveHeartbeat(new Date(Date.now() + 1_000));
    await Promise.resolve();
    expect(db.markCompleted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(lease.assertOwned()).rejects.toBeInstanceOf(AgentQualityEvaluationLeaseLostError);
  });

  it('rejects a delayed ownership check after its local lease already expired', async () => {
    let resolveHeartbeat!: (expiry: Date) => void;
    const heartbeat = vi.fn().mockImplementation(() => new Promise<Date>(resolve => {
      resolveHeartbeat = resolve;
    }));
    const { lease } = createLease(heartbeat);
    // Stop scheduled heartbeats from replacing the resolver for assertOwned.
    heartbeat.mockImplementationOnce(() => new Promise<Date>(resolve => {
      resolveHeartbeat = resolve;
    })).mockImplementation(() => new Promise<Date>(() => undefined));
    const ownership = expect(lease.assertOwned()).rejects.toBeInstanceOf(AgentQualityEvaluationLeaseLostError);
    await vi.advanceTimersByTimeAsync(1_000);
    resolveHeartbeat(new Date(Date.now() + 1_000));
    await ownership;
    expect(lease.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops timers even when the completion transition fails', async () => {
    const { lease, db } = createLease(vi.fn().mockResolvedValue(new Date(Date.now() + 1_000)));
    db.markCompleted.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(lease.complete({})).rejects.toThrow('database unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
