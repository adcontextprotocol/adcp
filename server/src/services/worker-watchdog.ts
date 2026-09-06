/**
 * Worker reachability watchdog.
 *
 * Runs on web machines. Polls `http://worker.process.<app>.internal:8080/internal/jobs`
 * on a fixed cadence and emits `logger.error` once consecutive failures cross a
 * threshold — `logger.error` auto-routes to #admin-errors via posthog (see
 * `posthog.ts`), so the alert reaches Slack without any extra wiring.
 *
 * Recovery: on each failure, attempts to start any worker machines in `stopped`
 * state via the Fly Machines API. If Fly reports a worker as `started` but it
 * remains unreachable through the failure threshold, the watchdog acquires a
 * Machine lease and cold-restarts one worker. The successful repair holds the
 * lease until its TTL expires, giving staggered web replicas a shared recovery
 * cooldown instead of cold-restarting the same worker again. Recovery is
 * attempted only once per outage by each replica.
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
const FLY_MUTATION_TIMEOUT_MS = 15_000;
const FLY_LEASE_TTL_SECONDS = 120;
const FLY_API_BASE = 'https://api.machines.dev/v1';

let intervalId: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let alerted = false;

interface FlyMachine {
  id: string;
  state: string;
  config?: { metadata?: { fly_process_group?: string } };
}

interface RecoveryResult {
  attempted: boolean;
  started: number;
  restarted?: number;
  stoppedWorkerCount?: number;
  startedWorkerCount?: number;
  reason?: string;
}

interface FlyMachineLease {
  data?: {
    nonce?: string;
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeWorker(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const appName = process.env.FLY_APP_NAME;
  if (!appName) {
    return { ok: false, reason: 'FLY_APP_NAME not set' };
  }
  const url = `http://worker.process.${appName}.internal:8080/internal/jobs`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function restartStartedWorker(
  appName: string,
  token: string,
  machine: FlyMachine,
): Promise<{ restarted: boolean; reason?: string }> {
  const machineUrl = `${FLY_API_BASE}/apps/${appName}/machines/${machine.id}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  let leaseNonce: string | undefined;
  let releaseLease = true;

  try {
    const leaseRes = await fetchWithTimeout(`${machineUrl}/lease`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        description: 'worker-watchdog recovery',
        ttl: FLY_LEASE_TTL_SECONDS,
      }),
    });
    if (leaseRes.status === 409) {
      return { restarted: false, reason: 'Worker recovery lease already held' };
    }
    if (!leaseRes.ok) {
      return {
        restarted: false,
        reason: `Fly Machines API lease failed: HTTP ${leaseRes.status}`,
      };
    }
    const lease = (await leaseRes.json()) as FlyMachineLease;
    leaseNonce = lease.data?.nonce;
    if (!leaseNonce) {
      return { restarted: false, reason: 'Fly Machines API lease response omitted nonce' };
    }

    const mutationHeaders = { ...headers, 'fly-machine-lease-nonce': leaseNonce };
    const stopRes = await fetchWithTimeout(`${machineUrl}/stop`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ signal: 'SIGTERM', timeout: '10' }),
    }, FLY_MUTATION_TIMEOUT_MS);
    if (!stopRes.ok) {
      return {
        restarted: false,
        reason: `Fly Machines API stop failed: HTTP ${stopRes.status}`,
      };
    }

    const startRes = await fetchWithTimeout(`${machineUrl}/start`, {
      method: 'POST',
      headers: mutationHeaders,
    }, FLY_MUTATION_TIMEOUT_MS);
    if (!startRes.ok) {
      return {
        restarted: false,
        reason: `Fly Machines API restart failed: HTTP ${startRes.status}`,
      };
    }

    // Keep the lease until its TTL expires after a successful restart. Web
    // watchdogs tick independently, so releasing immediately would let a
    // staggered replica acquire the lease and restart the same worker again.
    releaseLease = false;
    logger.info(
      { machineId: machine.id, recoveryFenceSeconds: FLY_LEASE_TTL_SECONDS },
      'Restarted unreachable worker machine',
    );
    return { restarted: true };
  } catch (err) {
    return {
      restarted: false,
      reason: `Fly Machines API restart errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Failed attempts release immediately so another replica can retry. A
    // successful attempt intentionally leaves the bounded lease as a shared
    // cross-replica recovery fence.
    if (leaseNonce && releaseLease) {
      try {
        const releaseRes = await fetchWithTimeout(`${machineUrl}/lease`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'fly-machine-lease-nonce': leaseNonce,
          },
        });
        if (!releaseRes.ok) {
          logger.warn(
            { machineId: machine.id, status: releaseRes.status },
            'Fly Machines API lease release failed',
          );
        }
      } catch (err) {
        logger.warn(
          { machineId: machine.id, err: err instanceof Error ? err.message : String(err) },
          'Fly Machines API lease release errored',
        );
      }
    }
  }
}

async function recoverWorkers(restartUnreachable: boolean): Promise<RecoveryResult> {
  const appName = process.env.FLY_APP_NAME;
  const token = process.env.FLY_API_TOKEN;
  if (!appName) return { attempted: false, started: 0, reason: 'FLY_APP_NAME not set' };
  if (!token) return { attempted: false, started: 0, reason: 'FLY_API_TOKEN not set' };

  const headers = { Authorization: `Bearer ${token}` };
  let machines: FlyMachine[];
  try {
    const listRes = await fetchWithTimeout(`${FLY_API_BASE}/apps/${appName}/machines`, { headers });
    if (!listRes.ok) {
      logger.warn({ status: listRes.status }, 'Fly Machines API list failed');
      return { attempted: true, started: 0, reason: `Fly Machines API list failed: HTTP ${listRes.status}` };
    }
    machines = (await listRes.json()) as FlyMachine[];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Fly Machines API list errored');
    return {
      attempted: true,
      started: 0,
      reason: `Fly Machines API list errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const workers = machines.filter((m) => m.config?.metadata?.fly_process_group === 'worker');
  const stoppedWorkers = workers.filter((m) => m.state === 'stopped');
  const startedWorkers = workers.filter((m) => m.state === 'started');

  let started = 0;
  for (const machine of stoppedWorkers) {
    try {
      const res = await fetchWithTimeout(`${FLY_API_BASE}/apps/${appName}/machines/${machine.id}/start`, {
        method: 'POST',
        headers,
      }, FLY_MUTATION_TIMEOUT_MS);
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

  let restarted = 0;
  let reason: string | undefined;
  // A stopped worker was already repaired above. Only cold-restart a worker
  // when Fly says it is started yet the service has missed the full threshold.
  // Restart one machine per outage to keep the repair's blast radius bounded.
  if (restartUnreachable && stoppedWorkers.length === 0 && startedWorkers[0]) {
    const restart = await restartStartedWorker(appName, token, startedWorkers[0]);
    restarted = restart.restarted ? 1 : 0;
    reason = restart.reason;
  }

  return {
    attempted: true,
    started,
    restarted,
    stoppedWorkerCount: stoppedWorkers.length,
    startedWorkerCount: startedWorkers.length,
    ...(reason ? { reason } : {}),
  };
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
  const recovery = await recoverWorkers(
    consecutiveFailures === FAILURE_THRESHOLD && !alerted,
  );

  if (consecutiveFailures === FAILURE_THRESHOLD && !alerted) {
    alerted = true;
    logger.error(
      { consecutiveFailures, reason: result.reason, recovery },
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
  restartStartedWorker,
  getState: () => ({ consecutiveFailures, alerted }),
  reset: () => {
    consecutiveFailures = 0;
    alerted = false;
  },
};
