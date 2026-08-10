import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  constructWorkOS: vi.fn(),
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: class MockWorkOS {
    constructor(apiKey: string, options: unknown) {
      mocks.constructWorkOS(apiKey, options);
    }
  },
}));

describe('WorkOS client request budgets', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.constructWorkOS.mockReset();
    vi.stubEnv('WORKOS_API_KEY', 'sk_test_timeout');
    vi.stubEnv('WORKOS_CLIENT_ID', 'client_test_timeout');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('bounds interactive Pipes requests without automatic retries', async () => {
    const { getPipesWorkos } = await import('../../src/auth/workos-client.js');

    getPipesWorkos();
    getPipesWorkos();

    expect(mocks.constructWorkOS).toHaveBeenCalledOnce();
    expect(mocks.constructWorkOS).toHaveBeenCalledWith('sk_test_timeout', {
      clientId: 'client_test_timeout',
      timeout: 10_000,
      maxRetries: 0,
    });
  });

  it('does not change retry or timeout policy for the general shared client', async () => {
    const { getWorkos } = await import('../../src/auth/workos-client.js');

    getWorkos();

    expect(mocks.constructWorkOS).toHaveBeenCalledWith('sk_test_timeout', {
      clientId: 'client_test_timeout',
    });
  });

  it('makes one SDK attempt when retries are disabled', async () => {
    const { WorkOS } = await vi.importActual<typeof import('@workos-inc/node')>(
      '@workos-inc/node',
    );
    const fetchFn = vi.fn((...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
      const [, init] = args;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const client = new WorkOS('sk_test_timeout', {
      clientId: 'client_test_timeout',
      timeout: 10,
      maxRetries: 0,
      fetchFn,
    });

    await expect(client.get('/test-timeout', {})).rejects.toMatchObject({ status: 408 });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
