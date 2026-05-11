/**
 * Worker reachability watchdog.
 *
 * Runs on web machines. Polls `http://worker.process.<app>.internal:8080/internal/jobs`
 * on a fixed cadence and emits `logger.error` once consecutive failures cross a
 * threshold — `logger.error` auto-routes to #admin-errors via posthog (see
 * `posthog.ts`), so the alert reaches Slack without any extra wiring.
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

let intervalId: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let alerted = false;

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
