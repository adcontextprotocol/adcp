#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..');
const RUNNER_FILE = path.join(REPO_ROOT, 'server', 'tests', 'manual', 'run-storyboards.ts');
const SHARDED_RUNNER = path.join(REPO_ROOT, 'scripts', 'run-storyboards-sharded.sh');
const ISOLATED_SHARDED_RUNNER = path.join(REPO_ROOT, 'scripts', 'run-storyboards-isolated-shards.sh');
const MATRIX_RUNNER = path.join(REPO_ROOT, 'scripts', 'run-storyboards-matrix.sh');
const STORYBOARD_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'training-agent-storyboards.yml');

function makeFakeRunner() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-shard-test-'));
  const runner = path.join(directory, 'fake-runner.cjs');
  fs.writeFileSync(runner, `#!/usr/bin/env node
const args = process.argv.slice(2);
const index = Number(args[args.indexOf('--shard-index') + 1]);
const count = Number(args[args.indexOf('--shard-count') + 1]);
console.log('Shard: ' + (index + 1) + '/' + count);
console.log('  storyboard_' + index + '                              ✓ ' + (10 + index) + 'P / ' + (index + 1) + 'S / ' + (index + 2) + 'N/A');
function finish() {
  if (process.env.OMIT_TOTALS_SHARD === String(index)) process.exit(143);
  console.log('\\n--- Totals ---');
  console.log('  storyboards: 1/1 clean');
  console.log('  steps: ' + (10 + index) + ' passed | ' + index + ' failed | ' + (index + 1) + ' skipped | ' + (index + 2) + ' not applicable');
  if (process.env.SELF_KILL_AFTER_TOTALS === '1') process.kill(process.pid, 'SIGKILL');
  process.exit(1);
}

const delay = Number(process.env.FAKE_RUNNER_DELAY_MS ?? 0);
if (delay > 0) setTimeout(finish, delay); else finish();
`);
  fs.chmodSync(runner, 0o755);
  return { directory, runner };
}

function makeFakeIsolatedRunner() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-isolated-shard-test-'));
  const runner = path.join(directory, 'fake-isolated-runner.cjs');
  fs.writeFileSync(runner, `#!/usr/bin/env node
const args = process.argv.slice(2);
const index = Number(args[args.indexOf('--shard-index') + 1]);
console.log('  child storyboards: 99/99 clean');
console.log('  child steps: 999 passed | 0 failed | 0 skipped | 0 not applicable');
if (process.env.MISSING_TOTALS_SHARD === String(index)) process.exit(0);
console.log('  storyboards: 1/1 clean');
console.log('  steps: ' + (10 + index) + ' passed | ' + index + ' failed | 0 skipped | 0 not applicable');
process.exit(process.env.FAILING_SHARD === String(index) ? 1 : 0);
`);
  fs.chmodSync(runner, 0o755);
  return { directory, runner };
}

test('runner shards the applicable storyboard list into deterministic contiguous ranges', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  assert.match(source, /const applicable = everything\.filter\(isApplicable\);/);
  assert.match(
    source,
    /Math\.floor\(applicable\.length \* shard\.index \/ shard\.count\)/,
  );
  assert.match(source, /applicable\.slice\(shardStart, shardEnd\)/);
});

test('resolved proposal lifecycle storyboards are not quarantined', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  const currentOnlyStart = source.indexOf('const CURRENT_SOURCE_KNOWN_FAILING_STORYBOARDS');
  const commonStart = source.indexOf('const KNOWN_FAILING_STORYBOARDS', currentOnlyStart);
  const currentOnlyBlock = source.slice(currentOnlyStart, commonStart);

  assert.doesNotMatch(currentOnlyBlock, /media_buy_seller\/proposal_finalize'/);
  assert.doesNotMatch(currentOnlyBlock, /media_buy_seller\/proposal_finalize_asap_timing'/);
  assert.match(
    source,
    /releasedComplianceVersion === undefined && CURRENT_SOURCE_KNOWN_FAILING_STORYBOARDS\.has\(sb\.id\)/,
  );
});

test('runner flushes complete shard totals before bypassing stalled platform disposal', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  const totalsIndex = source.indexOf('console.log(`  steps: ${totals.passed} passed');
  const flushIndex = source.lastIndexOf("process.stdout.write('', resolve)");
  const killIndex = source.lastIndexOf("process.kill(process.pid, 'SIGKILL')");
  assert.ok(totalsIndex >= 0, 'expected final totals output');
  assert.ok(flushIndex > totalsIndex, 'stdout must flush after final totals');
  assert.ok(killIndex > flushIndex, 'forced shard exit must follow stdout flush');
});

test('sharded runner preserves storyboard lines and emits one aggregate totals block', (t) => {
  const { directory, runner } = makeFakeRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('bash', [SHARDED_RUNNER, '--shard-count', '2'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, STORYBOARD_RUNNER_BIN: runner },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  storyboard_0\s+✓/m);
  assert.match(result.stdout, /^  storyboard_1\s+✓/m);
  assert.equal((result.stdout.match(/storyboards:/g) ?? []).length, 1);
  assert.match(result.stdout, /storyboards: 2\/2 clean/);
  assert.match(result.stdout, /steps: 21 passed \| 1 failed \| 3 skipped \| 5 not applicable/);
});

test('sharded runner streams progress before a shard exits', async (t) => {
  const { directory, runner } = makeFakeRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const startedAt = Date.now();
  let storyboardSeenAt;
  const child = spawn('bash', [SHARDED_RUNNER, '--shard-count', '1'], {
    cwd: REPO_ROOT,
    env: { ...process.env, STORYBOARD_RUNNER_BIN: runner, FAKE_RUNNER_DELAY_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (storyboardSeenAt === undefined && chunk.includes('storyboard_0')) {
      storyboardSeenAt = Date.now();
    }
  });

  const [status] = await once(child, 'close');
  assert.equal(status, 0);
  assert.notEqual(storyboardSeenAt, undefined, 'expected streamed storyboard output');
  assert.ok(storyboardSeenAt - startedAt < 2000, 'storyboard output was buffered until shard exit');
});

test('sharded runner omits aggregate totals when any shard is interrupted', (t) => {
  const { directory, runner } = makeFakeRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('bash', [SHARDED_RUNNER, '--shard-count', '2'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, STORYBOARD_RUNNER_BIN: runner, OMIT_TOTALS_SHARD: '1' },
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /storyboards:/);
  assert.match(result.stderr, /shard 2\/2 exited 143 without a complete totals block/);
});

test('sharded runner aggregates complete totals from a self-terminated shard', (t) => {
  const { directory, runner } = makeFakeRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('bash', [SHARDED_RUNNER, '--shard-count', '1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, STORYBOARD_RUNNER_BIN: runner, SELF_KILL_AFTER_TOTALS: '1' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /storyboards: 1\/1 clean/);
  assert.match(result.stdout, /steps: 10 passed \| 0 failed \| 1 skipped \| 2 not applicable/);
});

test('isolated shard coordinator aggregates only one top-level totals block per shard', (t) => {
  const { directory, runner } = makeFakeIsolatedRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('bash', [ISOLATED_SHARDED_RUNNER, '--shard-count', '2', '--max-parallel', '2'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, STORYBOARD_ISOLATED_RUNNER_BIN: runner },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  storyboards: 2\/2 clean$/m);
  assert.match(result.stdout, /^  steps: 21 passed \| 1 failed \| 0 skipped \| 0 not applicable$/m);
  assert.equal((result.stdout.match(/^\s*storyboards:/gm) ?? []).length, 1);
  assert.equal((result.stdout.match(/^\s*steps:/gm) ?? []).length, 1);
});

test('isolated shard coordinator fails closed on missing totals or a nonzero shard', (t) => {
  const { directory, runner } = makeFakeIsolatedRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = env => spawnSync('bash', [ISOLATED_SHARDED_RUNNER, '--shard-count', '2', '--max-parallel', '2'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, STORYBOARD_ISOLATED_RUNNER_BIN: runner, ...env },
  });

  const missing = run({ MISSING_TOTALS_SHARD: '1' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /expected exactly one of each/);

  const failed = run({ FAILING_SHARD: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Isolated shard 2\/2 exited 1/);
  assert.match(failed.stdout, /^  storyboards: 2\/2 clean$/m);
});

test('isolated shard coordinator rejects missing option values', () => {
  for (const option of ['--shard-count', '--max-parallel']) {
    const result = spawnSync('bash', [ISOLATED_SHARDED_RUNNER, option], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`${option} requires an integer argument`));
  }
});

test('current /sales runs fixed orchestrators with isolated children behind one aggregate required check', () => {
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  const matrixRunner = fs.readFileSync(MATRIX_RUNNER, 'utf8');

  assert.match(workflow, /exclude:\n\s+- surface: current\n\s+tenant: sales/);
  assert.match(workflow, /sales_storyboard_orchestrators:/);
  assert.match(workflow, /max-parallel: 4/);
  assert.match(workflow, /orchestrator: \[0, 1, 2, 3, 4, 5, 6, 7\]/);
  assert.match(workflow, /SALES_ORCHESTRATOR_COUNT: 8/);
  assert.match(workflow, /node scripts\/run-storyboards-isolated\.mjs/);
  assert.match(workflow, /--shard-index "\$\{\{ matrix\.orchestrator \}\}"/);
  assert.match(workflow, /sales_storyboards:\n\s+name: Storyboards \(current \/sales\)/);
  assert.match(workflow, /needs: sales_storyboard_orchestrators/);
  assert.match(workflow, /ORCHESTRATOR_RESULT: \$\{\{ needs\.sales_storyboard_orchestrators\.result \}\}/);
  assert.match(workflow, /MIN_CLEAN: 120/);
  assert.match(workflow, /MIN_PASSED: 534/);
  assert.match(matrixRunner, /"sales:120:534"/);
  assert.match(matrixRunner, /bash scripts\/run-storyboards-isolated-shards\.sh/);
  assert.match(matrixRunner, /--shard-count 8 --max-parallel 4/);
  assert.match(matrixRunner, /orchestrator_failure=1/);
  assert.match(workflow, /media_buy_seller\/compact_direct_buy_lifecycle:7:0/);
});
