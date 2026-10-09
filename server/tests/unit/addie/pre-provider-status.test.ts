import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRE_PROVIDER_STATUS_DELAY_MS, startPreProviderStatusTimer } from '../../../src/routes/addie-chat.js';

describe('web chat pre-provider progress', () => {
  afterEach(() => vi.useRealTimers());

  it('emits one delayed content-free SSE status without any response prose', () => {
    vi.useFakeTimers();
    const sendEvent = vi.fn();
    startPreProviderStatusTimer(sendEvent);
    vi.advanceTimersByTime(PRE_PROVIDER_STATUS_DELAY_MS - 1);
    expect(sendEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendEvent).toHaveBeenCalledOnce();
    expect(sendEvent).toHaveBeenCalledWith('status', { stage: 'preparing_context' });
    expect(Object.keys(sendEvent.mock.calls[0]?.[1] as Record<string, unknown>)).toEqual(['stage']);
  });

  it('can be canceled once provider streaming begins', () => {
    vi.useFakeTimers();
    const sendEvent = vi.fn();
    const timer = startPreProviderStatusTimer(sendEvent);
    clearTimeout(timer);
    vi.advanceTimersByTime(PRE_PROVIDER_STATUS_DELAY_MS);
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
