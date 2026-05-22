/**
 * Worker reachability watchdog.
 *
 * Runs on web machines. Polls `http://worker.process.<app>.internal:8080/internal/jobs`
 * on a fixed cadence and emits `logger.error` once consecutive failures cross a
 * threshold — `logger.error` auto-routes to #admin-errors via posthog (see
 * `posthog.ts`), so the alert reaches Slack without any extra wiring.
 *
 * Recovery: on each failure, attempts to start any worker machines in `stopped`
 * state via the Fly Machines API. Rolling deploys can leave the worker stopped
 * because `auto_start_machines` is a fly-proxy feature and the worker has no
 * `[[services.ports]]` (see fly.toml). Without active recovery, nothing brings
 * a stopped worker back. Started machines surface as a successful probe on the
 * next tick; if start didn't help (real crashloop), failures keep climbing and
 * the alert still fires at the threshold.
 *
 * Fire-once semantics: alert when the failure streak crosses the threshold, and
 * again on recovery (info level). Without these guards a flapping worker would
 * spam the channel every tick.
 */
import { createLogger } from '../logger.js';

const logger = createLogger('worker-watchdog');

const TICK_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const FETCH_TIMEOUT_MS = 5_000;
const FLY_API_BASE = 'https://api.machines.dev/v1';

let intervalId: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let alerted = false;

interface FlyMachine {
  id: string;
  state: string;
  config?: { metadata?: { fly_process_group?: string } };
}

async function probeWorker(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const appName = process.env.FLY_APP_NAME;
  if (!appName) {
    return { ok: false, reason: 'FLY_APP_NAME not set' };
  }
  const url = `http://worker.process.${appName}.internal:8080/internal/jobs`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function recoverStoppedWorkers(): Promise<number> {
  const appName = process.env.FLY_APP_NAME;
  const token = process.env.FLY_API_TOKEN;
  if (!appName || !token) return 0;

  const headers = { Authorization: `Bearer ${token}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let machines: FlyMachine[];
  try {
    const listRes = await fetch(`${FLY_API_BASE}/apps/${appName}/machines`, {
      headers,
      signal: controller.signal,
    });
    if (!listRes.ok) {
      logger.warn({ status: listRes.status }, 'Fly Machines API list failed');
      return 0;
    }
    machines = (await listRes.json()) as FlyMachine[];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Fly Machines API list errored');
    return 0;
  } finally {
    clearTimeout(timer);
  }

  const stoppedWorkers = machines.filter(
    (m) => m.config?.metadata?.fly_process_group === 'worker' && m.state === 'stopped',
  );
  if (stoppedWorkers.length === 0) return 0;

  let started = 0;
  for (const machine of stoppedWorkers) {
    try {
      const res = await fetch(`${FLY_API_BASE}/apps/${appName}/machines/${machine.id}/start`, {
        method: 'POST',
        headers,
      });
      if (res.ok) {
        started++;
        logger.info({ machineId: machine.id }, 'Started stopped worker machine');
      } else {
        logger.warn({ machineId: machine.id, status: res.status }, 'Fly Machines API start failed');
      }
    } catch (err) {
      logger.warn(
        { machineId: machine.id, err: err instanceof Error ? err.message : String(err) },
        'Fly Machines API start errored',
      );
    }
  }
  return started;
}

async function tick(): Promise<void> {
  const result = await probeWorker();
  if (result.ok) {
    if (alerted) {
      logger.info({ priorFailures: consecutiveFailures }, 'Worker reachable again');
    }
    consecutiveFailures = 0;
    alerted = false;
    return;
  }

  consecutiveFailures++;
  await recoverStoppedWorkers();

  if (consecutiveFailures === FAILURE_THRESHOLD && !alerted) {
    alerted = true;
    logger.error(
      { consecutiveFailures, reason: result.reason },
      `Worker unreachable for ${FAILURE_THRESHOLD} consecutive checks (${FAILURE_THRESHOLD * TICK_MS / 1000}s) — scheduled jobs are not running`,
    );
  }
}

export function startWorkerWatchdog(): void {
  if (intervalId !== null) return;
  if (!process.env.FLY_APP_NAME) {
    logger.info('FLY_APP_NAME not set — watchdog disabled (local dev)');
    return;
  }
  intervalId = setInterval(() => {
    void tick();
  }, TICK_MS);
  intervalId.unref();
  logger.info({ tickMs: TICK_MS, failureThreshold: FAILURE_THRESHOLD }, 'Worker watchdog started');
}

export function stopWorkerWatchdog(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  consecutiveFailures = 0;
  alerted = false;
}

export const _internals = {
  tick,
  probeWorker,
  getState: () => ({ consecutiveFailures, alerted }),
  reset: () => {
    consecutiveFailures = 0;
    alerted = false;
  },
};
