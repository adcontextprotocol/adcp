'use strict';

// Worker count for the server unit suite, shared by server/vitest.config.ts
// (its default maxWorkers) and scripts/precommit-server-unit.cjs.
//
// Reused vitest workers grow as they run more files: at 12 workers (about 70
// files each) a worker peaked at 1.1-1.3 GB RSS (median), 1.5-1.8 GB (p90)
// and 2.0-2.3 GB (max); one worker running a whole project reached 3.0-3.3 GB.
// Fewer workers run more files each, so the budget assumes the high end.
const os = require('node:os');

/** Peak RSS budgeted per worker. */
const WORKER_MEMORY_BYTES = 2 * 1024 ** 3;
/** Share of total memory the suite may use; the rest is for the OS, IDE, etc. */
const MEMORY_SHARE = 0.5;
/** Env override for the worker count (a positive integer). */
const WORKERS_ENV = 'ADCP_PRECOMMIT_SERVER_UNIT_WORKERS';

function positiveInt(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (/^[1-9][0-9]*$/.test(raw)) return Number(raw);
  console.warn(`Ignoring invalid ${name}=${raw}; expected a positive integer.`);
  return null;
}

/**
 * The CPU count minus `reservedCpus`, capped so that every worker fits its
 * memory budget, never below one. ADCP_PRECOMMIT_SERVER_UNIT_WORKERS wins.
 */
function resolveWorkerCount({
  env = process.env,
  cpus = os.availableParallelism?.() ?? os.cpus().length,
  totalmem = os.totalmem(),
  reservedCpus = 2,
} = {}) {
  const override = positiveInt(env, WORKERS_ENV);
  if (override !== null) return override;
  const byCpu = cpus - reservedCpus;
  const byMemory = Math.floor((totalmem * MEMORY_SHARE) / WORKER_MEMORY_BYTES);
  return Math.max(1, Math.min(byCpu, byMemory));
}

module.exports = { resolveWorkerCount, WORKER_MEMORY_BYTES, MEMORY_SHARE, WORKERS_ENV };
