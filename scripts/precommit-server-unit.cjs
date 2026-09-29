#!/usr/bin/env node
'use strict';

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
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

// The full suite runs one file at a time per process (server/vitest.config.ts
// sets fileParallelism: false), so a single run no longer fits the hook
// budget. Run it as parallel shards, the same split CI uses. Set
// ADCP_PRECOMMIT_SERVER_UNIT_SHARDS=1 to keep the old serial run.
const SHARDS_ENV = 'ADCP_PRECOMMIT_SERVER_UNIT_SHARDS';
const MAX_DEFAULT_SHARDS = 4;
const SERVER_DIR = path.resolve(__dirname, '..', 'server');

function resolveShardCount(env = process.env, cpus = os.availableParallelism?.() ?? os.cpus().length) {
  const raw = env[SHARDS_ENV];
  if (raw !== undefined && raw !== '') {
    if (/^[1-9][0-9]*$/.test(raw)) return Number(raw);
    console.warn(`Ignoring invalid ${SHARDS_ENV}=${raw}; expected a positive integer.`);
  }
  return Math.max(1, Math.min(MAX_DEFAULT_SHARDS, Math.floor(cpus / 2)));
}

// Server-root-relative files that failed in a vitest JSON report, or null
// when the report is missing or unreadable (a crashed shard must not pass).
function failedFilesFromReport(reportPath, serverDir = SERVER_DIR) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(report.testResults)) return null;
  return report.testResults
    .filter((result) => result.status === 'failed')
    .map((result) => path.relative(serverDir, result.name).replace(/\\/g, '/'))
    .sort();
}

function runShard(index, total, reportPath) {
  return new Promise((resolve) => {
    const child = spawn('npm', [
      'run', '--silent', 'test:server-unit', '--',
      `--shard=${index}/${total}`,
      '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const prefix = `[shard ${index}/${total}] `;
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let pending = '';
      stream.on('data', (chunk) => {
        const lines = (pending + chunk.toString('utf8')).split('\n');
        pending = lines.pop();
        for (const line of lines) sink.write(prefix + line + '\n');
      });
      stream.on('end', () => { if (pending) sink.write(prefix + pending + '\n'); });
    }
    child.on('error', (error) => { console.error(prefix + error.message); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runFullSuite() {
  const shards = resolveShardCount();
  if (shards === 1) return run('npm', ['run', 'test:server-unit']);

  console.log(`Running the full server unit suite as ${shards} parallel shards (${SHARDS_ENV}=1 for a serial run).`);
  const reportDir = mkdtempSync(path.join(os.tmpdir(), 'precommit-server-unit-'));
  try {
    const reports = Array.from({ length: shards }, (_, i) => path.join(reportDir, `shard-${i + 1}.json`));
    const codes = await Promise.all(reports.map((report, i) => runShard(i + 1, shards, report)));
    if (codes.every((code) => code === 0)) return 0;

    const failed = [];
    for (const [i, code] of codes.entries()) {
      if (code === 0) continue;
      const files = failedFilesFromReport(reports[i]);
      if (!files || files.length === 0) {
        console.error(`Shard ${i + 1}/${shards} exited ${code} without a readable list of failed test files.`);
        return code || 1;
      }
      failed.push(...files);
    }

    // Some suites have wall-clock budgets that parallel shards can exceed.
    // Re-run only the failed files once, serially; the hook passes only if
    // they pass in isolation, and it names them either way.
    console.warn(`Re-running ${failed.length} file(s) that failed under parallel load, serially: ${failed.join(', ')}`);
    const rerun = run('npm', ['exec', '--', 'vitest', 'run', '--config', 'server/vitest.config.ts', ...failed]);
    if (rerun === 0) {
      console.warn(`Passed on isolated re-run (likely load-sensitive): ${failed.join(', ')}`);
    }
    return rerun;
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

async function main() {
  const plan = planServerUnitRun(stagedFiles(), existsSync);

  if (plan.kind === 'skip') {
    console.log('No staged server unit changes; skipping server unit precommit check.');
    return 0;
  }

  if (plan.kind === 'full') {
    console.log('Server implementation/config/schema changed; running full server unit suite.');
    return runFullSuite();
  }

  console.log(`Running ${plan.files.length} changed server unit test file(s).`);
  return run('npm', ['exec', '--', 'vitest', 'run', '--config', 'server/vitest.config.ts', ...plan.files]);
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  failedFilesFromReport,
  planServerUnitRun,
  resolveShardCount,
  pathsFromNameStatus,
  SERVER_UNIT_TEST_RE,
  FULL_SERVER_UNIT_PATTERNS,
};
