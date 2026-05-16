import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _internals } from '../../src/services/worker-watchdog.js';
import { logger } from '../../src/logger.js';

describe('worker-watchdog', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _internals.reset();
    process.env.FLY_APP_NAME = 'adcp-docs';
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    delete process.env.FLY_APP_NAME;
    vi.restoreAllMocks();
  });

  it('does not alert on a single failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await _internals.tick();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(_internals.getState()).toEqual({ consecutiveFailures: 1, alerted: false });
  });

  it('alerts exactly once after the third consecutive failure', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'));
    await _internals.tick();
    await _internals.tick();
    await _internals.tick();
    expect(errorSpy).toHaveBeenCalledOnce();
    // Subsequent failures don't re-alert
    await _internals.tick();
    await _internals.tick();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(_internals.getState().alerted).toBe(true);
  });

  it('logs recovery after a prior alert', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    await _internals.tick();
    await _internals.tick();
    await _internals.tick(); // alerts
    expect(errorSpy).toHaveBeenCalledOnce();

    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await _internals.tick();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ priorFailures: 3 }),
      'Worker reachable again',
    );
    expect(_internals.getState()).toEqual({ consecutiveFailures: 0, alerted: false });
  });

  it('treats non-2xx as a failure', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream error', { status: 502 }));
    await _internals.tick();
    await _internals.tick();
    await _internals.tick();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'HTTP 502' }),
      expect.any(String),
    );
  });

  it('resets streak on transient success', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('first'));
    fetchSpy.mockRejectedValueOnce(new Error('second'));
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    fetchSpy.mockRejectedValueOnce(new Error('third'));
    await _internals.tick();
    await _internals.tick();
    await _internals.tick(); // success
    await _internals.tick(); // failure after success → streak = 1
    expect(errorSpy).not.toHaveBeenCalled();
    expect(_internals.getState()).toEqual({ consecutiveFailures: 1, alerted: false });
  });
});
