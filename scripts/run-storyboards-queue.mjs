#!/usr/bin/env node

/**
 * One queue for every training-agent process of the local storyboard matrix.
 *
 * scripts/run-storyboards-matrix.sh prepares a surface (builds, bundle and
 * schema-root selection) and writes a plan: its tenants, how each runs, and
 * the log each writes. This queue runs every planned process from one pool of
 * ADCP_STORYBOARD_JOBS slots: each single-process tenant run, and each
 * discovery and storyboard batch of an isolated tenant (current /sales and
 * /creative-builder). An isolated batch is up to
 * STORYBOARD_STORYBOARDS_PER_PROCESS (the matrix's default 12) consecutive
 * storyboards in one worker process; each storyboard keeps its own timeout,
 * RSS, output and envelope checks. The process management is
 * run-storyboards-isolated.mjs's, reused as is. Each tenant log gets the text
 * a serial run writes, so the matrix grades it unchanged.
 *
 *   node scripts/run-storyboards-queue.mjs --surface current --surface 3.0-compat
 *       prepare, run and grade both surfaces (the pre-push storyboard phase);
 *       prints the current surface, then the 3.0 compatibility surface
 *   node scripts/run-storyboards-queue.mjs --state <dir> [--state <dir>...]
 *       run the plans of surfaces the matrix already prepared
 *   node scripts/run-storyboards-queue.mjs --write-plan <dir> <label> [isolated options] -- <tenant mode log>...
 *       (used by the matrix's --prepare phase)
 *
 * ADCP_STORYBOARD_JOBS=1 runs every process one after another. Like the
 * isolated orchestrator, the queue never loads the SDK or the training agent.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createPool,
  killActiveChildren,
  killProcessGroup,
  orchestrateIsolated,
  parseArgs as parseIsolatedArgs,
} from './run-storyboards-isolated.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = join(REPO_ROOT, 'scripts', 'run-storyboards-matrix.sh');
const RESERVED_CPUS = 2;
const LOGICAL_CPUS_PER_CORE = 2;
const CORES_PER_JOB = 1.35;
const MEMORY_PER_JOB_BYTES = 3 * 1024 ** 3;
// The environment the matrix's --prepare phase sets for its training agents,
// carried to every process the queue starts.
const PLAN_ENV = [
  'ADCP_COMPLIANCE_DIR',
  'ADCP_SCHEMA_ROOT',
  'ADCP_STORYBOARD_CANDIDATE_VERSION_MODE',
  'ADCP_RELEASE_GIT_REF',
  'ADCP_VALIDATOR_CACHE_DIR',
  'PUBLIC_TEST_AGENT_TOKEN',
];

function positiveInt(raw) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The memory the queue may plan for: physical memory, or the cgroup limit
 * when one is set (process.constrainedMemory() reports 0 or a value above
 * physical memory when there is none).
 */
function plannableMemoryBytes() {
  const total = os.totalmem();
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  return constrained > 0 && constrained < total ? constrained : total;
}

function performanceCores() {
  try {
    return positiveInt(execFileSync('sysctl', ['-n', 'hw.perflevel0.physicalcpu'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    return undefined;
  }
}

/**
 * The physical cores the queue may fill. macOS on Apple silicon has no SMT,
 * so its performance cores are physical cores. Elsewhere a logical CPU may be
 * an SMT sibling or a hypervisor thread on one, so all CPUs but two
 * (as scripts/precommit-server-unit.cjs) count as half as many cores.
 */
function plannableCores() {
  if (process.platform === 'darwin') {
    const performance = performanceCores();
    if (performance) return performance;
  }
  return (os.availableParallelism() - RESERVED_CPUS) / LOGICAL_CPUS_PER_CORE;
}

/**
 * How many training-agent processes run at once, sized by both cores and
 * memory.
 *
 * Cores: the plannable cores divided by the 1.35 cores one training-agent
 * process keeps busy (its main thread plus V8's compiler and GC threads; the
 * B0 matrix used 18,234 CPU-s in 6,845 s with two processes at a time). On
 * a 40-CPU Linux VM (19 plannable cores, so 14 processes) the pre-push
 * storyboard phase took 1,185 s and 20,879 CPU-s, and the slowest isolated
 * child took 84 s of its 180 s timeout. With 25 processes it took 1,069 s
 * but 30,327 CPU-s, and the slowest child took 154 s: past the physical
 * cores, more processes only make each one slower.
 *
 * Memory: 3 GiB per process. A single-process tenant peaks at about 3.3 GB;
 * an isolated worker runs with --max-old-space-size=2048, is killed above its
 * 4 GiB RSS limit and replaced above 2 GiB between storyboards; one process
 * ran all 198 current /sales storyboards at 1.58 GiB.
 *
 * ADCP_STORYBOARD_JOBS overrides; an invalid value is ignored.
 */
function resolveJobCount(env = process.env) {
  const requested = env.ADCP_STORYBOARD_JOBS;
  if (requested !== undefined && requested !== '') {
    const value = positiveInt(requested);
    if (value) return value;
    process.stderr.write(`Ignoring invalid ADCP_STORYBOARD_JOBS=${requested}\n`);
  }
  return Math.max(1, Math.min(
    Math.floor(plannableCores() / CORES_PER_JOB),
    Math.floor(plannableMemoryBytes() / MEMORY_PER_JOB_BYTES),
  ));
}

// --- Plans ------------------------------------------------------------------

function writePlan(argv) {
  const [stateDir, label, ...rest] = argv;
  const separator = rest.indexOf('--');
  if (!stateDir || label === undefined || separator === -1) {
    throw new Error('--write-plan <state-dir> <label> [isolated options] -- <tenant mode log>...');
  }
  const isolatedArgs = rest.slice(0, separator);
  const entries = rest.slice(separator + 1);
  if (entries.length % 3 !== 0) throw new Error('--write-plan expects tenant, mode and log triples');
  const tenants = [];
  for (let index = 0; index < entries.length; index += 3) {
    const [tenant, mode, log] = entries.slice(index, index + 3);
    if (!['monolithic', 'isolated'].includes(mode)) throw new Error(`unknown tenant mode ${mode}`);
    tenants.push({ tenant, mode, log });
  }
  // Fail now, not mid-run, if the isolated options are invalid.
  parseIsolatedArgs(isolatedArgs);
  const env = Object.fromEntries(PLAN_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  writeFileSync(join(stateDir, 'plan.json'), JSON.stringify({ label, env, isolatedArgs, tenants }, null, 2));
}

function readPlan(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, 'plan.json'), 'utf8'));
}

// --- Jobs -------------------------------------------------------------------

const monolithicGroups = new Set();

function monolithicCommand(env) {
  const fixtureRunner = env.STORYBOARD_RUNNER_BIN;
  if (fixtureRunner) {
    const runner = resolve(fixtureRunner);
    return /\.(?:c?js|mjs)$/.test(runner)
      ? [process.execPath, [runner]]
      : [runner, []];
  }
  return ['npx', ['tsx', 'server/tests/manual/run-storyboards.ts']];
}

// One process for the whole tenant, its stdout and stderr in its log, as the
// matrix's `npx tsx server/tests/manual/run-storyboards.ts > log 2>&1` did.
// Its exit status is not graded; the matrix grades its counts.
function runMonolithicTenant(tenantEnv, log) {
  const fd = openSync(log, 'w');
  const [command, args] = monolithicCommand(tenantEnv);
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: tenantEnv,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  monolithicGroups.add(child.pid);
  return new Promise((resolveRun) => {
    const finish = () => {
      monolithicGroups.delete(child.pid);
      closeSync(fd);
      resolveRun(0);
    };
    child.once('error', (error) => {
      writeSync(fd, `Failed to start the storyboard runner: ${error.message}\n`);
      finish();
    });
    child.once('close', finish);
  });
}

/**
 * One isolated tenant, written to its log exactly as
 * `node scripts/run-storyboards-isolated.mjs <isolated options> > log 2>&1`
 * writes it, with its discovery and storyboard children in the shared pool.
 * Resolves to that orchestrator's exit status.
 */
async function runIsolatedTenant({ pool, tenantEnv, isolatedArgs, log, spillDirectory }) {
  const config = parseIsolatedArgs(isolatedArgs);
  const fd = openSync(log, 'w');
  const write = text => writeSync(fd, text);
  mkdirSync(spillDirectory, { recursive: true });
  try {
    return await orchestrateIsolated({
      config,
      pool,
      sink: { out: write, err: write },
      env: tenantEnv,
      spillDirectory,
    });
  } catch (error) {
    write(`Fatal isolated storyboard runner error: ${error instanceof Error ? error.stack : String(error)}\n`);
    return 1;
  } finally {
    closeSync(fd);
    rmSync(spillDirectory, { recursive: true, force: true });
  }
}

/** Runs one prepared surface; resolves when every tenant log is complete. */
function runPlan(pool, stateDir) {
  const plan = readPlan(stateDir);
  return Promise.all(plan.tenants.map(async ({ tenant, mode, log }, index) => {
    const tenantEnv = { ...process.env, ...plan.env, TENANT_PATH: tenant };
    const status = mode === 'isolated'
      ? await runIsolatedTenant({
          pool,
          tenantEnv,
          isolatedArgs: plan.isolatedArgs,
          log,
          spillDirectory: join(stateDir, `spill-${index}`),
        })
      : await pool.run('monolithic', () => runMonolithicTenant(tenantEnv, log));
    writeFileSync(join(stateDir, `status-${index}`), `${status}\n`);
  }));
}

// --- Surfaces (the pre-push storyboard phase) ---------------------------------

const scriptGroups = new Set();

/** Runs the matrix script for a phase; streams or buffers its output. */
function runMatrixPhase(args, env, { stream }) {
  const child = spawn('bash', [MATRIX, ...args], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', stream ? 'inherit' : 'pipe', stream ? 'inherit' : 'pipe'],
  });
  scriptGroups.add(child.pid);
  let output = '';
  if (!stream) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
  }
  return new Promise((resolvePhase) => {
    child.once('error', (error) => {
      scriptGroups.delete(child.pid);
      resolvePhase({ status: 1, output: `${output}${error.message}\n` });
    });
    child.once('close', (code) => {
      scriptGroups.delete(child.pid);
      resolvePhase({ status: code ?? 1, output });
    });
  });
}

const ownedStateDirs = new Set();

function newStateDir() {
  const dir = mkdtempSync(join(os.tmpdir(), 'storyboards-queue-state-'));
  ownedStateDirs.add(dir);
  return dir;
}

function removeOwnedStateDirs() {
  for (const dir of ownedStateDirs) rmSync(dir, { recursive: true, force: true });
  ownedStateDirs.clear();
}

const SURFACES = {
  current: {
    args: [],
    env: env => ({
      ...env,
      // Mirror CI (training-agent-storyboards.yml): current-source runs on main
      // grade the package's own candidate version in candidate mode.
      ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE ?? '1',
    }),
  },
  // As scripts/run-storyboards-3-0-compat.sh: immutable 3.0 bundles never use
  // current-candidate schema resolution.
  '3.0-compat': {
    args: ['--latest-3.0'],
    env: env => ({ ...env, ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '0' }),
    heading: '\n🔍 Verifying 3.0 storyboard compatibility...\n',
  },
};

async function runSurfaces(names, pool) {
  const surfaces = names.map((name) => {
    const surface = SURFACES[name];
    if (!surface) throw new Error(`unknown surface ${name} (expected: ${Object.keys(SURFACES).join(', ')})`);
    return { name, ...surface, stateDir: newStateDir(), stream: name === names[0] };
  });
  const results = [];
  let previousPrepare = Promise.resolve();
  for (const surface of surfaces) {
    const env = surface.env(process.env);
    // The first surface (current) builds dist/schemas/latest, which every
    // training agent reads, so nothing else starts until it is prepared.
    // Later surfaces only select committed bundles; they prepare while
    // earlier surfaces' processes run.
    const prepared = previousPrepare.then(() => runMatrixPhase(
      [...surface.args, '--prepare', surface.stateDir],
      env,
      { stream: surface.stream },
    ));
    if (surface === surfaces[0]) previousPrepare = prepared;
    results.push(prepared.then(async (prepare) => {
      if (prepare.status !== 0) return { surface, status: prepare.status, output: prepare.output };
      await runPlan(pool, surface.stateDir);
      return { surface, prepareOutput: prepare.output, env };
    }));
  }
  let status = 0;
  // Grade and print in surface order: the current surface as soon as its
  // processes finish, the 3.0 compatibility surface after it.
  for (const pending of results) {
    const result = await pending;
    const { surface } = result;
    if (!surface.stream && surface.heading) process.stdout.write(surface.heading);
    if (result.status !== undefined) {
      process.stdout.write(result.output);
      status = 1;
      continue;
    }
    if (!surface.stream) process.stdout.write(result.prepareOutput);
    const grade = await runMatrixPhase(['--grade', surface.stateDir], result.env, { stream: surface.stream });
    if (!surface.stream) process.stdout.write(grade.output);
    if (grade.status !== 0) status = 1;
  }
  return status;
}

// --- CLI --------------------------------------------------------------------

function stopEverything(signal) {
  killActiveChildren();
  for (const pid of [...monolithicGroups, ...scriptGroups]) {
    try {
      killProcessGroup(pid);
    } catch {}
  }
  removeOwnedStateDirs();
  process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
}

async function main(argv) {
  if (argv[0] === '--write-plan') {
    writePlan(argv.slice(1));
    return 0;
  }
  const states = [];
  const surfaces = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--state') states.push(argv[++index]);
    else if (argv[index] === '--surface') surfaces.push(argv[++index]);
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if ((states.length === 0) === (surfaces.length === 0) || states.includes(undefined) || surfaces.includes(undefined)) {
    throw new Error('usage: --surface <current|3.0-compat>... | --state <dir>... | --write-plan ...');
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => stopEverything(signal));
  process.once('exit', removeOwnedStateDirs);
  process.chdir(REPO_ROOT);
  const pool = createPool(resolveJobCount(), ['monolithic', 'discovery', 'child']);
  if (surfaces.length > 0) {
    process.stdout.write(`Storyboard queue: up to ${pool.size} training-agent processes at once (ADCP_STORYBOARD_JOBS).\n`);
  }
  if (states.length > 0) {
    await Promise.all(states.map(stateDir => runPlan(pool, stateDir)));
    return process.exitCode ?? 0;
  }
  return runSurfaces(surfaces, pool);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (status) => { process.exitCode = status; },
    (error) => {
      process.stderr.write(`Storyboard queue error: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
