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
  assert.match(workflow, /MIN_CLEAN: 133/);
  assert.match(workflow, /MIN_PASSED: 632/);
  assert.match(matrixRunner, /"sales:133:632"/);
  assert.match(workflow, /Training agent · current \/sales/);
  assert.match(workflow, /echo "failed=\$\{failed_sum\}"/);
  assert.match(workflow, /echo "not_applicable=\$\{not_applicable_sum\}"/);
  assert.match(matrixRunner, /bash scripts\/run-storyboards-isolated-shards\.sh/);
  assert.match(matrixRunner, /--shard-count 8 --max-parallel 2 --timeout-ms 180000/);
  assert.match(matrixRunner, /orchestrator_failure=1/);
  assert.match(workflow, /wholesale_feed_products_scope_isolation/);
  assert.match(workflow, /media_buy_seller\/compact_direct_buy_lifecycle:7:0/);
});

test('creative-builder uses bounded isolated children in local and CI matrices', () => {
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  const matrixRunner = fs.readFileSync(MATRIX_RUNNER, 'utf8');

  assert.match(
    workflow,
    /if \[ "\$\{\{ matrix\.tenant \}\}" = "creative-builder" \] \|\| \{[^\n]+; then\n\s+bash scripts\/run-storyboards-isolated-shards\.sh/,
  );
  assert.match(workflow, /--shard-count 8 --max-parallel 4/);
  assert.match(workflow, /isolated_orchestrator_failure=0/);
  assert.match(workflow, /\| tee \/tmp\/storyboards\.log \|\| isolated_orchestrator_failure=1/);
  assert.match(workflow, /if \[ "\$\{isolated_orchestrator_failure\}" -ne 0 \]; then/);
  assert.match(
    matrixRunner,
    /\|\| \[ "\$\{tenant\}" = "creative-builder" \]; then\n\s+TENANT_PATH=/,
  );
});

test('current training-agent floors are ratcheted and mirrored by local and CI runners', () => {
  const workflow = fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8');
  const matrixRunner = fs.readFileSync(MATRIX_RUNNER, 'utf8');
  // governance and brand dropped one passing step each when
  // canonical_format_validate_input stopped listing comply_test_controller in
  // required_tools: both tenants expose the controller but not validate_input,
  // so the storyboard is no longer selected for them and the single step it
  // contributed is gone. Deliberate de-ratchet, not a regression — the
  // clean-storyboard floors are untouched.
  const baselines = [
    ['signals', 45, 80],
    ['sales', 133, 632],
    ['governance', 47, 160],
    ['creative', 49, 209],
    ['creative-builder', 50, 184],
    ['brand', 45, 115],
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
    ['signals', 24, 98],
    ['sales', 39, 219],
    ['governance', 27, 147],
    ['creative', 22, 109],
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

// Exercise both unchanged graders with the real routing shell. The fixture
// emits exact boundary counts; no network or training-agent state is involved.
function makeCreativeGradingFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-creative-grading-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'bin'));
  const matrix = fs.readFileSync(MATRIX_RUNNER, 'utf8');
  fs.writeFileSync(path.join(directory, 'scripts/run-storyboards-matrix.sh'), matrix);
  for (const kind of ['schemas', 'compliance']) {
    fs.mkdirSync(path.join(directory, `dist/${kind}/latest`), { recursive: true });
    fs.writeFileSync(path.join(directory, `dist/${kind}/latest/index.json`), '{"adcp_version":"3.2.0-rc.3"}');
    fs.writeFileSync(path.join(directory, `scripts/build-${kind}.cjs`), '');
  }
  const required = [...new Map([...matrix.matchAll(/^  "([^"\n]+)"$/gm)]
    .map(match => [match[1].split(':')[0], match[1]])).values()];
  const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const isolated = process.argv.includes('isolated');
const creative = process.env.TENANT_PATH === 'creative';
fs.appendFileSync(process.env.INVOCATIONS, JSON.stringify({
  tenant: process.env.TENANT_PATH, isolated, args: process.argv.slice(2),
  token: process.env.PUBLIC_TEST_AGENT_TOKEN, compliance: process.env.ADCP_COMPLIANCE_DIR,
  schema: process.env.ADCP_SCHEMA_ROOT, candidate: process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE,
}) + '\\n');
for (const requirement of ${JSON.stringify(required)}) {
  const [id, passed = '1', skipped = '0'] = requirement.split(':');
  console.log('  ' + id + ' ✓ ' + passed + 'P / ' + skipped + 'S / 0N/A');
}
if (creative && process.env.OMIT_TOTALS === '1') process.exit(1);
console.log('  storyboards: ' + (creative ? process.env.CREATIVE_CLEAN : '1000') + '/1000 clean');
console.log('  selection: 59 applicable | 143 not applicable | 2 quarantined | 204 corpus');
console.log('  steps: ' + (creative ? process.env.CREATIVE_PASSED : '1000') + ' passed | 1 failed | 96 skipped | 0 not applicable');
process.exit(creative ? Number(process.env.CREATIVE_EXIT) : 0);
`;
  const runner = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(runner, fixture);
  fs.writeFileSync(path.join(directory, 'scripts/run-storyboards-isolated-shards.sh'), 'exec node ./fixture.cjs isolated "$@"\n');
  const npx = path.join(directory, 'bin/npx');
  fs.writeFileSync(npx, '#!/usr/bin/env bash\nexec node ./fixture.cjs monolithic "$@"\n', { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${directory}/bin:${process.env.PATH}`,
    INVOCATIONS: path.join(directory, 'invocations.jsonl'),
    GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
    PUBLIC_TEST_AGENT_TOKEN: 'fixture-token', ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1',
    ADCP_SCHEMA_ROOT: path.join(directory, 'dist/schemas/latest'),
    ADCP_COMPLIANCE_DIR: path.join(directory, 'dist/compliance/latest'),
    CREATIVE_CLEAN: '49', CREATIVE_PASSED: '209', CREATIVE_EXIT: '0',
  };
  return { directory, env };
}

const workflowDefinition = require('yaml').parse(fs.readFileSync(STORYBOARD_WORKFLOW, 'utf8'));
const workflowSteps = workflowDefinition.jobs.storyboards.steps;
function workflowScript(step, directory, tenant = 'creative', surface = 'current') {
  return step.run.replaceAll('${{ matrix.tenant }}', tenant)
    .replaceAll('${{ matrix.surface }}', surface)
    .replaceAll('${{ steps.compat-bundle.outputs.version }}', '3.0.26')
    .replaceAll('/tmp/storyboards.log', path.join(directory, 'storyboards.log'));
}

for (const target of ['matrix', 'workflow']) {
  test(`${target} isolates current /creative and preserves exact floors, counts, environment and failures`, (t) => {
    const { directory, env } = makeCreativeGradingFixture(t);
    const run = overrides => spawnSync('bash', target === 'matrix'
      ? ['scripts/run-storyboards-matrix.sh']
      : ['-c', workflowScript(workflowSteps.find(step => step.id === 'run'), directory)], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...env, TENANT_PATH: 'creative', ...overrides },
    });
    const success = run({});
    assert.equal(success.status, 0, success.stderr + success.stdout);
    const invocations = fs.readFileSync(env.INVOCATIONS, 'utf8').trim().split('\n').map(JSON.parse);
    const creative = invocations.find(entry => entry.tenant === 'creative');
    assert.equal(creative.isolated, true);
    assert.deepEqual(creative.args, ['isolated', '--shard-count', '8', '--max-parallel', target === 'matrix' ? '2' : '4',
      ...(target === 'matrix' ? ['--timeout-ms', '180000'] : [])]);
    assert.equal(creative.token, 'fixture-token');
    assert.equal(creative.schema, env.ADCP_SCHEMA_ROOT);
    assert.equal(creative.compliance, env.ADCP_COMPLIANCE_DIR);
    assert.equal(creative.candidate, '1');
    if (target === 'matrix') {
      assert.match(success.stdout, /\/creative: ✓ 49 clean, 209 steps/);
      assert.equal(invocations.length, 7);
      assert.deepEqual(invocations.filter(entry => entry.isolated).map(entry => entry.tenant), ['sales', 'creative', 'creative-builder']);
    } else {
      assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'),
        'clean=49\ntotal=1000\napplicable=59\nscope_not_applicable=143\nquarantined=2\ncorpus=204\npassed=209\nfailed=1\nskipped=96\nnot_applicable=0\n');
    }
    for (const overrides of [{ CREATIVE_EXIT: '1' }, { OMIT_TOTALS: '1' }]) {
      const failed = run(overrides);
      assert.equal(failed.status, 1, failed.stderr + failed.stdout);
      if (target === 'matrix') assert.match(failed.stdout, /\/si: ✓/);
    }
    for (const [clean, passed, expected] of [['49', '209', 0], ['48', '209', 1], ['49', '208', 1]]) {
      const graded = target === 'matrix' ? run({ CREATIVE_CLEAN: clean, CREATIVE_PASSED: passed })
        : spawnSync('bash', ['-c', workflowScript(workflowSteps.find(step => step.name?.startsWith('Enforce non-regression')), directory)], {
          cwd: directory, encoding: 'utf8', env: { ...env, CLEAN: clean, PASSED: passed, MIN_CLEAN: '49', MIN_PASSED: '209' },
        });
      assert.equal(graded.status, expected, graded.stderr + graded.stdout);
    }
  });
}

test('workflow preserves creative job selection, floors, required-clean checks and failure artifact', () => {
  const job = workflowDefinition.jobs.storyboards;
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix.include.find(row => row.surface === 'current' && row.tenant === 'creative'),
    { surface: 'current', tenant: 'creative', min_clean_storyboards: 49, min_passing_steps: 209 });
  assert.equal(job.strategy.matrix.exclude.some(row => row.tenant === 'creative'), false);
  const run = workflowSteps.find(step => step.id === 'run');
  assert.equal(run.env.TENANT_PATH, '${{ matrix.tenant }}');
  assert.equal(run.env.PUBLIC_TEST_AGENT_TOKEN, 'storyboard-ci-token');
  assert.match(run.env.ADCP_COMPLIANCE_DIR, /dist\/compliance\/latest/);
  assert.match(run.env.ADCP_SCHEMA_ROOT, /dist\/schemas\/latest/);
  assert.match(run.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE, /matrix.surface == 'current'/);
  const artifact = workflowSteps.find(step => step.name === 'Upload storyboards log on failure');
  assert.equal(artifact.if, 'failure()');
  assert.deepEqual(artifact.with, { name: 'storyboards-log-${{ matrix.surface }}-${{ matrix.tenant }}',
    path: '/tmp/storyboards.log', 'retention-days': 14, 'if-no-files-found': 'ignore' });
  const required = workflowSteps.find(step => step.name === 'Enforce creative required-clean storyboards');
  assert.match(required.run, /"canonical_format_validate_input"\n\s+"creative\/billing_out_of_band"/);
  assert.match(required.run, /exit 1/);
});

test('workflow leaves 3.0 creative monolithic and preserves creative-builder isolation on both surfaces', (t) => {
  const { directory, env } = makeCreativeGradingFixture(t);
  for (const [tenant, surface, isolated] of [['creative', '3.0-compat', false], ['creative-builder', 'current', true], ['creative-builder', '3.0-compat', true]]) {
    const result = spawnSync('bash', ['-c', workflowScript(workflowSteps.find(step => step.id === 'run'), directory, tenant, surface)], {
      cwd: directory, encoding: 'utf8', env: { ...env, TENANT_PATH: tenant },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const invocation = JSON.parse(fs.readFileSync(env.INVOCATIONS, 'utf8').trim().split('\n').at(-1));
    assert.equal(invocation.isolated, isolated);
  }
});

for (const failure of ['', 'crash', 'hang', 'malformed_result', 'inconsistent_result']) {
  test(`creative isolated shards preserve exact child results and siblings: ${failure || 'success'}`, () => {
    const ids = ['healthy_before', 'creative_ad_server', ...(failure ? [failure] : []), 'healthy_after'];
    const result = spawnSync('bash', [ISOLATED_SHARDED_RUNNER, '--shard-count', '2', '--max-parallel', '2', '--timeout-ms', '1500'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TENANT_PATH: 'creative', STORYBOARD_RUNNER_BIN: path.join(REPO_ROOT, 'tests/fixtures/storyboard-isolation-runner.cjs'),
        FIXTURE_STORYBOARDS: ids.join(',') },
    });
    assert.equal(result.status, failure ? 1 : 0, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(`^  storyboards: 3/${ids.length} clean$`, 'm'));
    assert.match(result.stdout, /^  steps: 8 passed \| 0 failed \| 0 skipped \| 0 not applicable$/m);
    assert.match(result.stdout, /^  healthy_before\s+✓/m);
    assert.match(result.stdout, /^  healthy_after\s+✓/m);
    if (failure) assert.match(result.stderr, /Isolated shard .* exited 1/);
  });
}

test('creative child task errors propagate exact failed and skipped counts through shards', () => {
  const result = spawnSync('bash', [ISOLATED_SHARDED_RUNNER, '--shard-count', '2', '--max-parallel', '2'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TENANT_PATH: 'creative', STORYBOARD_RUNNER_BIN: path.join(REPO_ROOT, 'tests/fixtures/storyboard-isolation-runner.cjs'),
      FIXTURE_STORYBOARDS: 'healthy_before,creative_ad_server,healthy_after', FIXTURE_CREATIVE_ERROR: '1' },
  });
  // Task results are graded by the unchanged floors; infrastructure failures
  // additionally fail the orchestrator even when aggregate floors are met.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  storyboards: 2\/3 clean$/m);
  assert.match(result.stdout, /^  steps: 6 passed \| 1 failed \| 1 skipped \| 0 not applicable$/m);
  assert.match(result.stdout, /^  healthy_after\s+✓/m);
});

test('registered storyboard suite runs the fail-closed operational changeset scope regressions', () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tests/changeset-protocol-scope.test.cjs')], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
