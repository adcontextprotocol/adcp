#!/usr/bin/env node
'use strict';

// Pre-commit step for the server unit suite (`npm run precommit:server-unit`).
//
// Contract: no arguments. It plans from the staged files: a change to server
// implementation, config, schemas or shared test helpers runs the full suite;
// staged server unit test files alone run just those files; anything else
// skips. It runs one vitest process and exits with vitest's exit code (0 on
// skip). Environment: ADCP_PRECOMMIT_SERVER_UNIT_PLAN=full|skip|auto forces
// the plan, ADCP_PRECOMMIT_SERVER_UNIT_WORKERS=N sets the worker count
// (default: CPU count minus two, capped by memory), ADCP_PRECOMMIT_REPORT_DIR=DIR keeps the
// vitest JSON report and per-file timings there.

const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_UNIT_TEST_RE = /^server\/tests\/unit\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/;

const FULL_SERVER_UNIT_PATTERNS = [
  /^server\/src\//,
  /^server\/scripts\//,
  /^server\/public\//,
  /^server\/tests\/setup\//,
  /^server\/tests\/unit\/(?!.*\.(?:test|spec)\.[cm]?[jt]sx?$)/,
  /^docs\//,
  /^static\/schemas\/source\//,
  /^static\/compliance\/source\//,
  /^static\/registry\//,
  /^server\/vitest\.config\.ts$/,
  /^scripts\/server-unit-workers\.cjs$/,
  /^server\/tsconfig\.json$/,
  /^vitest\.config\.ts$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^scripts\/generate-c2pa-cert\.sh$/,
  /^\.agents\//,
  /^\.claude\/agents\//,
];

function pathsFromNameStatus(output) {
  const tokens = output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const paths = [];

  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) break;

    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
      continue;
    }

    const file = tokens[i++];
    if (file) paths.push(file);
  }

  return paths.map((file) => file.replace(/\\/g, '/'));
}

function stagedFiles() {
  // Merge commits with main can stage tens of thousands of dist/ files;
  // Node's default 1 MB maxBuffer overflows (ENOBUFS) on the -z listing.
  const output = execFileSync('git', ['diff', '--cached', '--name-status', '--diff-filter=ACMRD', '-z'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return pathsFromNameStatus(output);
}

function planServerUnitRun(files, fileExists = () => true) {
  const normalized = files.map((file) => file.replace(/\\/g, '/'));

  if (normalized.some((file) => FULL_SERVER_UNIT_PATTERNS.some((pattern) => pattern.test(file)))) {
    return { kind: 'full', files: [] };
  }

  const testFiles = [...new Set(normalized.filter((file) => SERVER_UNIT_TEST_RE.test(file) && fileExists(file)))].sort();
  if (testFiles.length > 0) {
    return { kind: 'files', files: testFiles };
  }

  return { kind: 'skip', files: [] };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

// The full suite is one vitest run. server/vitest.config.ts reuses worker
// processes across unit test files (`isolate: false`) and keeps a fresh
// process only for the files it lists as isolated; vitest schedules both
// projects over the same workers, longest files first from its duration
// cache. ADCP_PRECOMMIT_SERVER_UNIT_WORKERS=N sets the worker count.
const { WORKERS_ENV, resolveWorkerCount: resolveServerUnitWorkers } = require('./server-unit-workers.cjs');

// Workers default to the CPU count minus two (one core for the vitest main
// process, one for the rest of the machine), capped by memory: see
// scripts/server-unit-workers.cjs.
function resolveWorkerCount(env = process.env, cpus, totalmem) {
  return resolveServerUnitWorkers({ env, cpus, totalmem, reservedCpus: 2 });
}

// ADCP_PRECOMMIT_REPORT_DIR keeps the vitest JSON report and per-file phase
// timings (the profiler's vitest reporter) in that directory, so
// scripts/profile-precommit.mjs can rank files after the run.
const REPORT_DIR_ENV = 'ADCP_PRECOMMIT_REPORT_DIR';
const TIMING_REPORTER = path.resolve(__dirname, 'profile-precommit', 'vitest-timing-reporter.mjs');

function keptReportArgs(name, env = process.env) {
  const dir = env[REPORT_DIR_ENV];
  if (!dir) return [];
  mkdirSync(dir, { recursive: true });
  env.ADCP_VITEST_TIMING_DIR ||= dir;
  const imports = env.ADCP_VITEST_IMPORT_DURATIONS;
  // Forked workers do not inherit --cpu-prof/--heap-prof from NODE_OPTIONS;
  // vitest's --execArgv passes them to every worker process.
  const profile = [
    ...(env.ADCP_VITEST_CPU_PROF_DIR ? ['--execArgv=--cpu-prof', `--execArgv=--cpu-prof-dir=${env.ADCP_VITEST_CPU_PROF_DIR}`] : []),
    ...(env.ADCP_VITEST_HEAP_PROF_DIR ? ['--execArgv=--heap-prof', `--execArgv=--heap-prof-dir=${env.ADCP_VITEST_HEAP_PROF_DIR}`] : []),
  ];
  return [
    '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(dir, name)}`,
    `--reporter=${TIMING_REPORTER}`,
    ...(/^[1-9]\d*$/.test(imports ?? '') ? [`--experimental.importDurations.limit=${imports}`] : []),
    ...profile,
  ];
}

function runFullSuite() {
  const workers = resolveWorkerCount();
  console.log(`Running the full server unit suite with ${workers} workers (${WORKERS_ENV}=N to change).`);
  return run('npm', ['run', 'test:server-unit', '--', `--maxWorkers=${workers}`, ...keptReportArgs('all.json')]);
}

// ADCP_PRECOMMIT_SERVER_UNIT_PLAN=full|skip forces the plan regardless of what
// is staged, so a profiling run can reproduce the full path without staging
// anything. Unset (or "auto") keeps the staged-file plan.
const PLAN_ENV = 'ADCP_PRECOMMIT_SERVER_UNIT_PLAN';

function resolvePlan(env = process.env) {
  const forced = env[PLAN_ENV];
  if (forced === 'full' || forced === 'skip') return { kind: forced, files: [] };
  if (forced && forced !== 'auto') console.warn(`Ignoring invalid ${PLAN_ENV}=${forced}; expected full, skip or auto.`);
  return planServerUnitRun(stagedFiles(), existsSync);
}

async function main() {
  const plan = resolvePlan();

  if (plan.kind === 'skip') {
    console.log('No staged server unit changes; skipping server unit precommit check.');
    return 0;
  }

  if (plan.kind === 'full') {
    console.log('Server implementation/config/schema changed; running full server unit suite.');
    return runFullSuite();
  }

  console.log(`Running ${plan.files.length} changed server unit test file(s).`);
  return run('npm', ['exec', '--', 'vitest', 'run', '--config', 'server/vitest.config.ts', ...keptReportArgs('files.json'), ...plan.files]);
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  planServerUnitRun,
  resolveWorkerCount,
  pathsFromNameStatus,
  SERVER_UNIT_TEST_RE,
  FULL_SERVER_UNIT_PATTERNS,
};
