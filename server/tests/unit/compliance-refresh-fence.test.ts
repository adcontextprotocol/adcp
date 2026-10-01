import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDedicatedClient: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getClient: vi.fn(),
  getDedicatedClient: mocks.getDedicatedClient,
  query: vi.fn(),
  withDatabaseDeadline: vi.fn(),
}));

import { ComplianceRefreshRequestsDatabase } from '../../src/db/compliance-refresh-requests-db.js';

describe('compliance refresh execution fence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('invalidates ownership when its bounded keepalive fails', async () => {
    vi.useFakeTimers();
    const client = Object.assign(new EventEmitter(), {
      connection: { stream: { destroyed: false, destroy: vi.fn() } },
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce(new Error('SENTINEL_CONNECTION_FAILURE')),
      end: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getDedicatedClient.mockResolvedValue(client);

    const fence = await new ComplianceRefreshRequestsDatabase().acquireAgentExecutionFence(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(fence?.isValid()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fence?.isValid()).toBe(false);

    await fence?.release();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('uses one of two database-wide heartbeat slots before fencing the agent', async () => {
    const first = Object.assign(new EventEmitter(), {
      connection: { stream: { destroyed: false, destroy: vi.fn() } },
      query: vi.fn().mockResolvedValueOnce({ rows: [{ acquired: false }] }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    const second = Object.assign(new EventEmitter(), {
      connection: { stream: { destroyed: false, destroy: vi.fn() } },
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValue({ rows: [{ acquired: true }] }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getDedicatedClient.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const fence = await new ComplianceRefreshRequestsDatabase().acquireHeartbeatExecutionFence('https://agent.example/mcp');

    expect(fence?.isValid()).toBe(true);
    expect(first.query.mock.calls[0][1]).toEqual(['compliance-suite-slot:0']);
    expect(second.query.mock.calls[0][1]).toEqual(['compliance-suite-slot:1']);
    expect(second.query.mock.calls[1][1]).toEqual(['compliance-agent-execution:https://agent.example/mcp']);
    await fence?.release();
    expect(second.end).toHaveBeenCalledOnce();
  });

  it('reserves the third suite slot for an owner refresh', async () => {
    const client = Object.assign(new EventEmitter(), {
      connection: { stream: { destroyed: false, destroy: vi.fn() } },
      query: vi.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getDedicatedClient.mockResolvedValueOnce(client);

    const fence = await new ComplianceRefreshRequestsDatabase().acquireExecutionFence(
      'operation-id', 'https://agent.example/mcp',
    );

    expect(fence?.isValid()).toBe(true);
    expect(client.query.mock.calls.slice(0, 3).map((call: unknown[]) => call[1])).toEqual([
      ['compliance-suite-slot:2'],
      ['compliance-refresh-fence:operation-id'],
      ['compliance-agent-execution:https://agent.example/mcp'],
    ]);
    await fence?.release();
  });
});
