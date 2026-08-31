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
});
