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
    delete process.env.FLY_API_TOKEN;
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          attempted: false,
          reason: 'FLY_API_TOKEN not set',
        }),
      }),
      expect.any(String),
    );
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

  describe('recovery via Fly Machines API', () => {
    beforeEach(() => {
      process.env.FLY_API_TOKEN = 'test-token';
    });

    it('starts a stopped worker machine on probe failure', async () => {
      // Probe fails, then API list returns one stopped worker, then start succeeds.
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'wk1', state: 'stopped', config: { metadata: { fly_process_group: 'worker' } } },
            { id: 'web1', state: 'started', config: { metadata: { fly_process_group: 'web' } } },
          ]),
          { status: 200 },
        ),
      );
      fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await _internals.tick();

      const startCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).endsWith('/machines/wk1/start'),
      );
      expect(startCall).toBeDefined();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: 'wk1' }),
        'Started stopped worker machine',
      );
    });

    it('does not call start when no worker machines are stopped', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('boom'));
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'wk1', state: 'started', config: { metadata: { fly_process_group: 'worker' } } },
          ]),
          { status: 200 },
        ),
      );

      await _internals.tick();

      const startCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes('/start'),
      );
      expect(startCall).toBeUndefined();
    });

    it('still alerts at threshold when recovery does not help', async () => {
      // Recovery on every failure tick: list returns empty (nothing to start).
      // Three probe failures, three list calls → alert fires once.
      for (let i = 0; i < 3; i++) {
        fetchSpy.mockRejectedValueOnce(new Error('unreachable'));
        fetchSpy.mockResolvedValueOnce(new Response('[]', { status: 200 }));
      }

      await _internals.tick();
      await _internals.tick();
      await _internals.tick();

      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it('skips recovery without FLY_API_TOKEN', async () => {
      delete process.env.FLY_API_TOKEN;
      fetchSpy.mockRejectedValueOnce(new Error('boom'));

      await _internals.tick();

      // Only the probe; no API calls.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
