import { describe, expect, it, vi } from 'vitest';
import {
  ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE,
  AddieTransientTransportError,
  createSdkSafeFetch,
} from '../../src/utils/sdk-safe-fetch.js';
import { NetworkPolicyRefusedError } from '../../src/utils/url-security.js';

describe('SDK safe fetch transient failure marker', () => {
  it('turns a nested typed network failure into SDK-projectable structured data', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });
    const safeFetch = vi.fn().mockRejectedValue(failure);
    const fetch = createSdkSafeFetch(safeFetch as never);

    const caught = await fetch('https://agent.example/mcp').catch(error => error);
    expect(caught).toBeInstanceOf(AddieTransientTransportError);
    expect(caught).toMatchObject({
      code: ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE,
      data: {
        adcp_error: {
          code: ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE,
          recovery: 'transient',
        },
      },
    });
  });

  it('marks typed transient HTTP statuses and preserves numeric retry-after', async () => {
    const safeFetch = vi.fn().mockResolvedValue(new Response('busy', {
      status: 503,
      headers: { 'retry-after': '0.5' },
    }));
    const fetch = createSdkSafeFetch(safeFetch as never);

    const caught = await fetch('https://agent.example/mcp').catch(error => error);
    expect(caught).toMatchObject({
      data: { adcp_error: { retry_after: 0.5 } },
      metadata: { status: 503, retryAfterMs: 500 },
    });
  });

  it('does not relabel policy denials as retryable transport failures', async () => {
    const refusal = new NetworkPolicyRefusedError('private address denied');
    const safeFetch = vi.fn().mockRejectedValue(refusal);
    const fetch = createSdkSafeFetch(safeFetch as never);

    await expect(fetch('https://agent.example/mcp')).rejects.toBe(refusal);
  });
});
