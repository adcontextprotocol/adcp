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
const PRE_PUSH_HOOK = path.join(REPO_ROOT, '.husky', 'pre-push');
const PREPUSH_WRAPPER = path.join(REPO_ROOT, 'scripts', 'run-storyboards-prepush.sh');
const QUEUE_RUNNER = path.join(REPO_ROOT, 'scripts', 'run-storyboards-queue.mjs');

// The whole shell command that contains `needle`: its line plus any
// backslash-continued lines before and after it.
function shellCommandContaining(source, needle) {
  const lines = source.split('\n');
  const index = lines.findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `expected a command containing ${needle}`);
  let start = index;
  while (start > 0 && lines[start - 1].trimEnd().endsWith('\\')) start -= 1;
  let end = index;
  while (end < lines.length - 1 && lines[end].trimEnd().endsWith('\\')) end += 1;
  return lines.slice(start, end + 1).join('\n');
}

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
  const applicable = process.env.INCONSISTENT_SELECTION_SHARD === String(index) ? 3 : 2;
  console.log('  selection: ' + applicable + ' applicable | 3 not applicable | 1 quarantined | 6 corpus');
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
const applicable = process.env.INCONSISTENT_SELECTION_SHARD === String(index) ? 3 : 2;
console.log('  selection: ' + applicable + ' applicable | 3 not applicable | 1 quarantined | 6 corpus');
console.log('  steps: ' + (10 + index) + ' passed | ' + index + ' failed | 0 skipped | 0 not applicable');
process.exit(process.env.FAILING_SHARD === String(index) ? 1 : 0);
`);
  fs.chmodSync(runner, 0o755);
  return { directory, runner };
}

test('runner resolves declared capabilities before deterministic sharding', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  assert.match(source, /testCapabilityDiscovery\(agentUrl,/);
  assert.match(source, /resolveStoryboardsForCapabilities\(\{/);
  assert.match(source, /refusing to guess storyboard applicability/);
  assert.match(source, /const \{ applicable \} = selection;/);
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
    /CURRENT_SOURCE_KNOWN_FAILING_STORYBOARDS\.get\(storyboardId\)/,
  );
  assert.match(
    source,
    /const isCurrentSourceRun =[\s\S]*resolve\('dist\/compliance\/latest'\)/,
    'an explicit dist/compliance/latest root must still use current-source quarantines',
  );
  assert.match(
    source,
    /const wireAdcpVersion = isThreeZeroCompatRun[\s\S]*isCurrentSourceRun[\s\S]*TRAINING_AGENT_CURRENT_ADCP_VERSION/,
    'an explicit dist/compliance/latest root must negotiate the current wire version',
  );
  assert.match(source, /\?\? \(isCurrentSourceRun/);
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
  assert.match(result.stdout, /selection: 2 applicable \| 3 not applicable \| 1 quarantined \| 6 corpus/);
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

test('sharded runner fails closed when shards resolve different capability selections', (t) => {
  const { directory, runner } = makeFakeRunner();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync('bash', [SHARDED_RUNNER, '--shard-count', '2'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, STORYBOARD_RUNNER_BIN: runner, INCONSISTENT_SELECTION_SHARD: '1' },
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /^--- Totals ---$/m);
  assert.match(result.stderr, /shard 2\/2 reported inconsistent capability selection/i);
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
  assert.match(result.stdout, /selection: 2 applicable \| 3 not applicable \| 1 quarantined \| 6 corpus/);
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
  assert.match(result.stdout, /^  selection: 2 applicable \| 3 not applicable \| 1 quarantined \| 6 corpus$/m);
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
  assert.match(missing.stderr, /incomplete or duplicate aggregate totals/);

  const failed = run({ FAILING_SHARD: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Isolated shard 2\/2 exited 1/);
  assert.match(failed.stdout, /^  storyboards: 2\/2 clean$/m);

  const inconsistent = run({ INCONSISTENT_SELECTION_SHARD: '1' });
  assert.equal(inconsistent.status, 1);
  assert.match(inconsistent.stderr, /Isolated shard 2\/2 reported inconsistent capability selection/);
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
  assert.match(workflow, /MIN_CLEAN: 191/);
  assert.match(workflow, /MIN_PASSED: 1400/);
  assert.match(matrixRunner, /"sales:191:1400"/);
  assert.match(workflow, /Training agent · current \/sales/);
  assert.match(workflow, /echo "failed=\$\{failed_sum\}"/);
  assert.match(workflow, /echo "not_applicable=\$\{not_applicable_sum\}"/);
  // Local /sales runs its storyboards through the one storyboard queue
  // (scripts/run-storyboards-queue.mjs, one discovery, a pool of
  // ADCP_STORYBOARD_JOBS) instead of eight shard orchestrators in lock-step
  // pairs, in workers of STORYBOARD_STORYBOARDS_PER_PROCESS storyboards. Same
  // 180 s per-storyboard timeout, same isolated-orchestrator failure flag; the
  // queue reuses run-storyboards-isolated.mjs's process management.
  const queueRunner = fs.readFileSync(QUEUE_RUNNER, 'utf8');
  assert.match(matrixRunner, /node "\$\{REPO_ROOT\}\/scripts\/run-storyboards-queue\.mjs" --state "\$\{STATE_DIR\}"/);
  assert.match(matrixRunner, /--timeout-ms "?\$\{STORYBOARD_TIMEOUT_MS:-180000\}"?/);
  assert.doesNotMatch(matrixRunner, /run-storyboards-isolated-shards\.sh/);
  assert.doesNotMatch(matrixRunner, /--max-parallel/);
  assert.match(matrixRunner, /orchestrator_failure=1/);
  assert.match(queueRunner, /from '\.\/run-storyboards-isolated\.mjs'/);
  assert.match(queueRunner, /'npx', \['tsx', 'server\/tests\/manual\/run-storyboards\.ts'\]/);
  assert.doesNotMatch(queueRunner, /(?:import|require)\s*\(?['"][^'"]*@adcp\/sdk/);
  assert.match(workflow, /wholesale_feed_products_scope_isolation/);
  assert.match(workflow, /media_buy_seller\/compact_direct_buy_lifecycle:9:0/);
});

test('creative-builder uses bounded isolated children in local and CI matrices', () => {
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  const matrixRunner = fs.readFileSync(MATRIX_RUNNER, 'utf8');

  assert.match(
    workflow,
    /if \[ "\$\{\{ matrix\.tenant \}\}" = "creative-builder" \] \|\| \[ "\$\{\{ matrix\.isolated \}\}" = "true" \]; then\n\s+bash scripts\/run-storyboards-isolated-shards\.sh/,
  );
  assert.match(workflow, /--shard-count 8 --max-parallel 4/);
  assert.match(workflow, /isolated_orchestrator_failure=0/);
  assert.match(workflow, /\| tee \/tmp\/storyboards\.log \|\| isolated_orchestrator_failure=1/);
  assert.match(workflow, /if \[ "\$\{isolated_orchestrator_failure\}" -ne 0 \]; then/);
  // creative-builder (and current /sales) are queued as isolated tenants: a
  // timeout, RSS, output and envelope check per storyboard.
  assert.match(
    matrixRunner,
    /\|\| \[ "\$\{tenant\}" = "creative-builder" \]; then\n\s+tenant_mode=isolated/,
  );
});

test('pre-push runs both storyboard surfaces through one wrapper that cannot skip builds', () => {
  const hook = fs.readFileSync(PRE_PUSH_HOOK, 'utf8');
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  assert.ok(fs.existsSync(PREPUSH_WRAPPER), 'scripts/run-storyboards-prepush.sh is missing');
  const wrapper = fs.readFileSync(PREPUSH_WRAPPER, 'utf8');

  const commandLines = hook.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('echo '));
  const storyboardCommands = commandLines.filter(line => /scripts\/run-storyboards-[\w.-]+\.sh/.test(line));
  assert.equal(storyboardCommands.length, 1, `expected one storyboard command, found:\n${storyboardCommands.join('\n')}`);
  assert.match(storyboardCommands[0], /^bash scripts\/run-storyboards-prepush\.sh(?:\s|$)/);
  assert.match(storyboardCommands[0], /\|\| exit 1$/);

  // The test-only build skip must never be reachable from the hook path.
  assert.doesNotMatch(hook, /ADCP_STORYBOARD_TEST_SKIP_BUILDS/);
  assert.doesNotMatch(wrapper, /ADCP_STORYBOARD_TEST_SKIP_BUILDS/);

  // Changes to the scripts the storyboard phase now runs re-trigger it.
  const pathsMatch = hook.match(/^STORYBOARD_PATHS='([^']+)'/m);
  assert.ok(pathsMatch, 'expected STORYBOARD_PATHS in the hook');
  const storyboardPaths = new RegExp(pathsMatch[1]);
  for (const file of [
    'scripts/run-storyboards-prepush.sh',
    'scripts/run-storyboards-matrix.sh',
    'scripts/run-storyboards-3-0-compat.sh',
    'scripts/run-storyboards-isolated.mjs',
    'scripts/run-storyboards-queue.mjs',
    'scripts/build-schemas.cjs',
  ]) {
    assert.match(file, storyboardPaths, `${file} must trigger the pre-push storyboard phase`);
  }

  // CI is unchanged: the queue is a local-only path.
  assert.doesNotMatch(workflow, /run-storyboards-queue/);
  assert.doesNotMatch(workflow, /run-storyboards-prepush/);
  assert.doesNotMatch(workflow, /ADCP_STORYBOARD_JOBS|STORYBOARD_CONCURRENCY|--concurrency/);
});

test('current training-agent floors are ratcheted and mirrored by local and CI runners', () => {
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  const matrixRunner = fs.readFileSync(MATRIX_RUNNER, 'utf8');
  // The CTV and premium-display validate_input gates previously admitted
  // controller-only /brand and /governance: 14 + 18 product seeds passed while
  // every validator check skipped. The live tool-catalog drift test replays
  // both gates and proves that exact loss. Subtract only those 32 setup passes;
  // pin all clean floors, other tenants, and the frozen 3.0 floors below.
  const baselines = [
    ['signals', 45, 80],
    ['sales', 191, 1400],
    ['governance', 47, 160 - (14 + 18)],
    ['creative', 49, 209],
    ['creative-builder', 50, 184],
    ['brand', 45, 115 - (14 + 18)],
    ['si', 42, 50],
  ];

  for (const [tenant, clean, passed] of baselines) {
    assert.match(matrixRunner, new RegExp(`"${tenant}:${clean}:${passed}"`));
    if (tenant === 'sales') continue;
    assert.match(
      workflow,
      new RegExp(
        `surface: current\\n\\s+tenant: ${tenant}\\n` +
        `\\s+min_clean_storyboards: ${clean}\\n\\s+min_passing_steps: ${passed}`,
      ),
    );
  }
});

test('3.0 compatibility floors are capability-resolved and mirrored locally', () => {
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  const matrixRunner = fs.readFileSync(MATRIX_RUNNER, 'utf8');
  const baselines = [
    ['signals', 24, 97],
    ['sales', 39, 219],
    ['governance', 27, 146],
    ['creative', 22, 108],
    ['creative-builder', 24, 112],
    ['brand', 22, 76],
    ['si', 21, 72],
  ];

  for (const [tenant, clean, passed] of baselines) {
    assert.match(matrixRunner, new RegExp(`"${tenant}:${clean}:${passed}"`));
    assert.match(
      workflow,
      new RegExp(
        `surface: 3\\.0-compat\\n\\s+tenant: ${tenant}\\n`
        + `\\s+min_clean_storyboards: ${clean}\\n\\s+min_passing_steps: ${passed}`,
      ),
    );
  }
});

// Guard against per-tenant serial launches coming back: the matrix and the
// pre-push wrapper never start a storyboard runner themselves. Every
// training-agent process is started by the one queue, which bounds them
// together. Returns the offending commands.
const STORYBOARD_RUN_COMMAND = /(?:npx tsx server\/tests\/manual\/run-storyboards\.ts|scripts\/run-storyboards-isolated\.mjs|scripts\/run-storyboards-isolated-shards\.sh|scripts\/run-storyboards-sharded\.sh|server\/tests\/manual\/run-storyboards\.ts)/;

function directRunnerLaunches(source) {
  const lines = source.split('\n');
  const offending = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line) || /^\s*echo\b/.test(line) || !STORYBOARD_RUN_COMMAND.test(line)) continue;
    let start = index;
    while (start > 0 && lines[start - 1].trimEnd().endsWith('\\')) start -= 1;
    let end = index;
    while (end < lines.length - 1 && lines[end].trimEnd().endsWith('\\')) end += 1;
    offending.push(lines.slice(start, end + 1).join('\n').trim());
    index = end;
  }
  return offending;
}

test('only the storyboard queue starts training-agent runners on the local path', () => {
  assert.deepEqual(directRunnerLaunches(fs.readFileSync(MATRIX_RUNNER, 'utf8')), []);
  assert.deepEqual(directRunnerLaunches(fs.readFileSync(PREPUSH_WRAPPER, 'utf8')), []);
});

test('the direct-launch guard flags serial, backgrounded and shard-coordinator launches', () => {
  // Negative: delegating to the queue, comments and echo lines pass.
  assert.deepEqual(directRunnerLaunches([
    'node scripts/run-storyboards-queue.mjs --state "${state_dir}"',
    '# npx tsx server/tests/manual/run-storyboards.ts in a comment',
    '    echo "   or run: bash scripts/run-storyboards-isolated-shards.sh"',
  ].join('\n')), []);
  // Positive: the old serial loop, a backgrounded launch and the shard
  // coordinator are flagged.
  assert.equal(directRunnerLaunches([
    'TENANT_PATH="${tenant}" \\',
    '  npx tsx server/tests/manual/run-storyboards.ts > "${log}" 2>&1 || true',
  ].join('\n')).length, 1);
  assert.equal(directRunnerLaunches('node scripts/run-storyboards-isolated.mjs --timeout-ms 180000 > "${log}" 2>&1 &').length, 1);
  assert.equal(directRunnerLaunches([
    '  bash scripts/run-storyboards-isolated-shards.sh \\',
    '    --shard-count 8 --max-parallel 2 --timeout-ms 180000 > "${log}" 2>&1',
  ].join('\n')).length, 1);
  // Would-be-missed: the runner started through node --import tsx, or named
  // on a continuation line, is still flagged.
  assert.equal(directRunnerLaunches('node --import tsx server/tests/manual/run-storyboards.ts --storyboard-id x').length, 1);
  assert.equal(directRunnerLaunches(['MONOLITHIC=(npx \\', '  tsx server/tests/manual/run-storyboards.ts)'].join('\n')).length, 1);
});
