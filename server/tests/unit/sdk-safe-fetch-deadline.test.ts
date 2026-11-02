import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/utils/url-security.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils/url-security.js')>()),
  safeFetch: mocks.fetch,
}));
import { withSdkSafeTransport } from '../../src/utils/sdk-safe-fetch.js';

describe('hosted storyboard overall deadline at the safe fetch boundary', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response('{}'));
  });
  it('refuses a pre-aborted invocation without network contact', () => {
    const controller = new AbortController();
    controller.abort();
    const { transport } = withSdkSafeTransport({ signal: controller.signal });
    expect(() => transport.fetchFn('https://seller.example/mcp')).toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('passes a deadline even when the SDK controller omits its signal, and blocks later pages', async () => {
    const controller = new AbortController();
    const { transport } = withSdkSafeTransport({ signal: controller.signal });
    await transport.fetchFn('https://seller.example/mcp', { method: 'POST', body: '{}' });
    const passedSignal = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    expect(passedSignal.aborted).toBe(false);
    controller.abort();
    expect(passedSignal.aborted).toBe(true);
    expect(() => transport.fetchFn('https://seller.example/mcp')).toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('composes request cancellation with the overall deadline', async () => {
    for (const cancelRequest of [false, true]) {
      const run = new AbortController(), request = new AbortController();
      const { transport } = withSdkSafeTransport({ signal: run.signal });
      await transport.fetchFn('https://seller.example/mcp', { signal: request.signal });
      const composed = mocks.fetch.mock.lastCall![1].signal as AbortSignal;
      expect(composed.aborted).toBe(false);
      (cancelRequest ? request : run).abort();
      expect(composed.aborted).toBe(true);
    }
  });
  it('cancels an in-flight controller exchange, including SDK calls with no request signal', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocks.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      started();
      options.signal.throwIfAborted();
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const { transport } = withSdkSafeTransport({ signal: controller.signal });
    const pending = transport.fetchFn('https://seller.example/mcp', { method: 'POST', body: '{}' });
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => transport.fetchFn('https://seller.example/mcp')).toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
