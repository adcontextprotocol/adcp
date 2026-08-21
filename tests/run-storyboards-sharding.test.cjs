#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..');
const RUNNER_FILE = path.join(REPO_ROOT, 'server', 'tests', 'manual', 'run-storyboards.ts');
const SHARDED_RUNNER = path.join(REPO_ROOT, 'scripts', 'run-storyboards-sharded.sh');

function makeFakeRunner() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-shard-test-'));
  const runner = path.join(directory, 'fake-runner.cjs');
  fs.writeFileSync(runner, `#!/usr/bin/env node
const args = process.argv.slice(2);
const index = Number(args[args.indexOf('--shard-index') + 1]);
const count = Number(args[args.indexOf('--shard-count') + 1]);
console.log('Shard: ' + (index + 1) + '/' + count);
console.log('  storyboard_' + index + '                              ✓ ' + (10 + index) + 'P / ' + (index + 1) + 'S / ' + (index + 2) + 'N/A');
if (process.env.OMIT_TOTALS_SHARD === String(index)) process.exit(143);
console.log('\\n--- Totals ---');
console.log('  storyboards: 1/1 clean');
console.log('  steps: ' + (10 + index) + ' passed | ' + index + ' failed | ' + (index + 1) + ' skipped | ' + (index + 2) + ' not applicable');
process.exit(1);
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
