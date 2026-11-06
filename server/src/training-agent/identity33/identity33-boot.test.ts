/**
 * Regression: the identity route must not touch the database while routes
 * mount. In production the server mounts routes before initializing the
 * pool, and a boot-time getReplayStore() threw, so no machine became healthy.
 */
import { describe, expect, it, vi } from 'vitest';

const replayStoreCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../request-signing.js', async () => {
  const actual = await vi.importActual<typeof import('../request-signing.js')>('../request-signing.js');
  return {
    ...actual,
    getReplayStore: () => {
      replayStoreCalls.count++;
      throw new Error('Database not initialized. Call initializeDatabase() first.');
    },
  };
});

describe('identity route boot', () => {
  it('mounts without initializing its runtime or reading the database', async () => {
    const previous = process.env.ENABLE_ADCP_3_3_IDENTITY_ROUTE;
    process.env.ENABLE_ADCP_3_3_IDENTITY_ROUTE = 'true';
    try {
      const { createTrainingAgentRouter } = await import('../index.js');
      expect(() => createTrainingAgentRouter()).not.toThrow();
      expect(replayStoreCalls.count).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ENABLE_ADCP_3_3_IDENTITY_ROUTE;
      else process.env.ENABLE_ADCP_3_3_IDENTITY_ROUTE = previous;
    }
  });
});
