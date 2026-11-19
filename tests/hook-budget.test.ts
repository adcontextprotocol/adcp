// One wall-clock budget per git hook, driven through the hooks' public surface:
//   sh -e .husky/pre-commit                       (as husky runs it)
//   sh -e .husky/pre-push origin <url>            (as husky runs it)
//   node scripts/profile-precommit.mjs hook [--name pre-commit|pre-push] [--budget-s N] [-- CMD ARGS...]
// Each case builds a throwaway git repo holding a COPY of the hook runner
// (scripts/profile-precommit.mjs and scripts/profile-precommit/), the real
// .husky/pre-commit and .husky/pre-push, a package.json with tiny leaf scripts
// and a stub image check, and asserts on what a user sees: the exit code, the
// terminal output, the run directory (<root>/.hook-runs/<stamp>-hook/ or
// <stamp>-pre-push-hook/: run.json and every step's report.json) and which
// fixture processes are still alive.
//
// Budget contract: pre-commit defaults to 120 s, pre-push to 180 s. First
// match wins: --budget-s N; ADCP_PRECOMMIT_BUDGET_S / ADCP_PREPUSH_BUDGET_S;
// ADCP_HOOK_BUDGET_S; the default. Anything but a positive number exits 2
// before a step starts. On expiry every running step's process tree (and any
// detached descendant) is killed within about 1 s, the hook prints one
// ⏰ TIMEOUT block naming each running step and how long it ran, later steps
// are skipped and the hook exits 124.
//
// Budgets here are 0.5-1 s and every bounded wait ends inside vitest's 10 s
// testTimeout (vitest.config.ts); a hook that never ends is SIGKILLed by the
// harness guard so the case fails on its assertions, not on a test timeout.
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import gitObjectFixture from './helpers/git-object-fixture.cjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const RUNNER = 'scripts/profile-precommit.mjs';

// ------------------------------------------------------------------ fixtures

// Shared helper every fixture leaf requires. Markers live in <root>/markers.
const FIXTURE_LIB = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const MARKERS = path.join(__dirname, '..', 'markers');
const file = (name) => path.join(MARKERS, name);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const has = (name) => fs.existsSync(file(name));
const mark = (name, text = '') => fs.writeFileSync(file(name), String(text));
const waitFor = (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; sleep(20); }
  return pred();
};
// Publishes this process's pid as <name>.pid and keeps running until killed.
const hold = (name) => { mark(name + '.pid', process.pid); setInterval(() => {}, 1000); };
// Starts scripts/stray.cjs in its OWN process group (detached), sharing this
// process's stdout and stderr, and returns once it has published its pid.
const startStray = (name) => {
  spawn(process.execPath, [path.join(__dirname, 'stray.cjs'), name], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  if (!waitFor(() => has(name + '.pid'), 2000)) { console.error(name + ' never started'); process.exit(1); }
};
module.exports = { has, mark, hold, startStray };
`;

// A detached descendant that ignores SIGTERM and holds the step's output.
const STRAY = [
  "process.on('SIGTERM', () => {});",
  "require('./fixture-lib.cjs').mark(process.argv[2] + '.pid', process.pid);",
  "process.stdout.write('stray: holding the step output\\n');",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

const LIB = "require('./fixture-lib.cjs')";
const leaf = {
  /** Records that it ran. */
  marks: (name: string) => `${LIB}.mark(${JSON.stringify(name)});\n`,
  /** Publishes its pid and runs until killed. */
  holds: (name: string) => `${LIB}.hold(${JSON.stringify(name)});\n`,
  /** Starts a detached SIGTERM-ignoring stray on its stdout, then publishes its pid and runs until killed. */
  holdsWithStray: (name: string, stray: string) =>
    `const lib = ${LIB};\nlib.startStray(${JSON.stringify(stray)});\nlib.hold(${JSON.stringify(name)});\n`,
  /** Records its argv in <name>.argv and exits with the number after --code. */
  exitsWith: (name: string) => [
    `const lib = ${LIB};`,
    'const argv = process.argv.slice(2);',
    `lib.mark(${JSON.stringify(`${name}.argv`)}, JSON.stringify(argv));`,
    "process.exit(Number(argv[argv.indexOf('--code') + 1]));",
    '',
  ].join('\n'),
};

const IMAGE_CHECK = '#!/bin/bash\ntouch "$(dirname "$0")/../markers/image-check-ran"\nexit 0\n';

// The pre-commit plan most cases share: one quick light leaf.
const QUICK_PLAN = { precommit: 'node scripts/typecheck-pass.cjs' };
const QUICK_FILES = { 'scripts/typecheck-pass.cjs': leaf.marks('pass-ran') };

const roots: string[] = [];
const hookGroups: number[] = [];

interface FixtureOptions {
  scripts: Record<string, string>;
  files?: Record<string, string>;
}

/**
 * A throwaway git repo: a copy of the hook runner, the real husky hooks, the
 * fixture helper and stray, a stub image check, package.json and leaf files.
 */
function fixtureRoot({ scripts, files = {} }: FixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'hook-budget-'));
  roots.push(root);
  for (const dir of ['markers', 'scripts/profile-precommit', '.husky', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(REPO_ROOT, RUNNER), join(root, RUNNER));
  for (const name of readdirSync(join(REPO_ROOT, 'scripts', 'profile-precommit'))) {
    copyFileSync(join(REPO_ROOT, 'scripts', 'profile-precommit', name), join(root, 'scripts', 'profile-precommit', name));
  }
  for (const hook of ['pre-commit', 'pre-push']) copyFileSync(join(REPO_ROOT, '.husky', hook), join(root, '.husky', hook));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'hook-budget-fixture', version: '0.0.0', private: true, scripts }, null, 2),
  );
  writeFileSync(join(root, 'scripts', 'fixture-lib.cjs'), FIXTURE_LIB);
  writeFileSync(join(root, 'scripts', 'stray.cjs'), STRAY);
  writeFileSync(join(root, 'scripts', 'check-image-quality.sh'), IMAGE_CHECK);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/**
 * Environment for the hook: no inherited budget, hook-runner, timeout-scale,
 * npm, vitest or husky state, and an empty XDG_CONFIG_HOME so no user husky
 * init script runs.
 */
function hookEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|ADCP_|NODE_OPTIONS$|VITEST|HUSKY)/i.test(key)) continue;
    env[key] = value;
  }
  env.XDG_CONFIG_HOME = join(root, 'xdg');
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  return { ...env, ...extra };
}

// ------------------------------------------------------------------- harness

interface HookResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  /** Date.now() when the test spawned the hook. */
  spawnAt: number;
  /** Date.now() when the hook process exited. */
  exitAt: number;
}

/**
 * Runs command with cwd = root in its own process group, as git runs a hook.
 * A hook that outlives guardMs is SIGKILLed (its whole group), inside the
 * test timeout; the stray/leaf pids are cleaned up by afterEach.
 */
function runHook(root: string, command: string, args: string[], env: NodeJS.ProcessEnv, guardMs = 5_000): Promise<HookResult> {
  const spawnAt = Date.now();
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  hookGroups.push(child.pid!);
  let stdout = '';
  let stderr = '';
  let output = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; output += chunk; });
  child.stderr!.on('data', (chunk) => { stderr += chunk; output += chunk; });
  return new Promise((resolveDone) => {
    const guard = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, guardMs);
    let settled = false;
    child.on('exit', (code, signal) => {
      const exitAt = Date.now();
      clearTimeout(guard);
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveDone({ code, signal, stdout, stderr, output, spawnAt, exitAt });
      };
      // A stray that still holds the hook's pipes must not hang the test.
      const fallback = setTimeout(finish, 1_000);
      child.on('close', () => { clearTimeout(fallback); finish(); });
    });
  });
}

/** sh -e .husky/<hook> [args], as husky 9 runs it. */
const runHuskyHook = (root: string, hook: 'pre-commit' | 'pre-push', env: NodeJS.ProcessEnv, args: string[] = []) =>
  runHook(root, 'sh', ['-e', `.husky/${hook}`, ...args], env);

/** node scripts/profile-precommit.mjs hook ARGS (the copy in root). */
const runRunner = (root: string, args: string[], env: NodeJS.ProcessEnv) => runHook(root, NODE, [RUNNER, 'hook', ...args], env);

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const marker = (root: string, name: string) => join(root, 'markers', name);

/** The pid a fixture process published as markers/<name>.pid; fails if it never did. */
function publishedPid(root: string, name: string, output: string): number {
  const file = marker(root, `${name}.pid`);
  expect(existsSync(file), `${name} never published its pid; hook output:\n${output}`).toBe(true);
  return Number(readFileSync(file, 'utf8'));
}

/** Fails if any of the named fixture processes is alive shortly after the hook exited. */
async function expectAllDead(root: string, names: string[], output: string) {
  const pids = names.map((name) => [name, publishedPid(root, name, output)] as const);
  // Only the OS's reaping of a killed, reparented process; not a kill grace.
  await waitUntil(() => pids.every(([, pid]) => !alive(pid)), 500);
  for (const [name, pid] of pids) expect(alive(pid), `${name} (pid ${pid}) outlived the hook`).toBe(false);
}

type HookName = 'pre-commit' | 'pre-push';

function runDirs(root: string, hook: HookName): string[] {
  const base = join(root, '.hook-runs');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((n) => (hook === 'pre-push' ? /-pre-push-hook$/.test(n) : /-hook$/.test(n) && !/-pre-push-hook$/.test(n)))
    .sort()
    .map((n) => join(base, n));
}

function onlyRunDir(root: string, hook: HookName, output: string): string {
  const dirs = runDirs(root, hook);
  expect(dirs, `exactly one ${hook} run directory under .hook-runs; hook output:\n${output}`).toHaveLength(1);
  return dirs[0];
}

function runJson(runDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
}

/** The budget block of the single <hook> run's run.json. */
function budgetOf(root: string, hook: HookName, output: string): Record<string, any> {
  const meta = runJson(onlyRunDir(root, hook, output));
  expect(meta.budget, `run.json has a budget block; run.json:\n${JSON.stringify(meta, null, 2)}`).toBeTypeOf('object');
  return meta.budget;
}

function stepReports(runDir: string): Record<string, any>[] {
  return readdirSync(runDir)
    .filter((n) => /^\d{2}-/.test(n) && existsSync(join(runDir, n, 'report.json')))
    .map((n) => JSON.parse(readFileSync(join(runDir, n, 'report.json'), 'utf8')));
}

/** The single step report whose content mentions needle. */
function stepFor(runDir: string, needle: string): Record<string, any> {
  const steps = stepReports(runDir).filter((r) => JSON.stringify(r).includes(needle));
  expect(steps.map((s) => s.name), `one step report mentions ${needle}`).toHaveLength(1);
  return steps[0];
}

const timeOf = (value: unknown) => (typeof value === 'number' ? value : Date.parse(String(value)));

/** The hook exited after its deadline and no more than ~1 s after it (kill, reap, summary and prune included). */
function expectExitNearDeadline(result: HookResult, budget: Record<string, any>) {
  const deadline = timeOf(budget.deadline_at);
  expect(Number.isFinite(deadline), `budget.deadline_at is a time: ${JSON.stringify(budget)}`).toBe(true);
  expect(Number.isFinite(timeOf(budget.expired_at)), `budget.expired_at is a time: ${JSON.stringify(budget)}`).toBe(true);
  expect(timeOf(budget.expired_at)).toBeGreaterThanOrEqual(deadline);
  expect(result.exitAt - deadline, 'ms from the deadline to the hook exit').toBeGreaterThanOrEqual(0);
  expect(result.exitAt - deadline, 'ms from the deadline to the hook exit').toBeLessThanOrEqual(1_500);
}

/** A line of the TIMEOUT block that names needle with an elapsed time in seconds. */
function expectNamedWithElapsed(output: string, needle: string) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(output, `TIMEOUT block names ${needle} with how long it ran`).toMatch(
    new RegExp(`${escaped}[^\\n]*\\b\\d+(?:\\.\\d+)?\\s?s\\b`),
  );
}

// Fixture repos run git; inside a linked-worktree hook the inherited GIT_DIR
// would point their `git init` at the caller's repository.
let restoreGitEnv = () => {};
beforeAll(() => { restoreGitEnv = gitObjectFixture.isolateGitEnv({ identity: false }); });
afterAll(() => restoreGitEnv());

afterEach(() => {
  for (const pgid of hookGroups.splice(0)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* group gone */ }
  }
  for (const root of roots.splice(0)) {
    // Fixture processes must not outlive their test, whatever the hook did.
    const markers = join(root, 'markers');
    if (existsSync(markers)) {
      for (const name of readdirSync(markers).filter((n) => n.endsWith('.pid'))) {
        const pid = Number(readFileSync(join(markers, name), 'utf8'));
        if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------- tests

describe('pre-commit hook budget (sh -e .husky/pre-commit)', () => {
  it('kills every running step and its detached SIGTERM-ignoring descendant at the deadline, names them, skips later steps and exits 124', async () => {
    const root = fixtureRoot({
      scripts: {
        precommit: 'npm run hold-alpha && npm run hold-beta && node scripts/precommit-server-unit.cjs',
        'hold-alpha': 'node scripts/typecheck-hold-alpha.cjs',
        'hold-beta': 'node scripts/typecheck-hold-beta.cjs',
      },
      files: {
        // Two concurrency-safe leaves in one phase; alpha leaves a detached
        // stray (own process group, ignores SIGTERM, holds alpha's stdout).
        'scripts/typecheck-hold-alpha.cjs': leaf.holdsWithStray('hold-alpha', 'stray-alpha'),
        'scripts/typecheck-hold-beta.cjs': leaf.holds('hold-beta'),
        'scripts/precommit-server-unit.cjs': leaf.marks('server-unit-ran'),
      },
    });

    const result = await runHuskyHook(root, 'pre-commit', hookEnv(root, { ADCP_PRECOMMIT_BUDGET_S: '1' }));

    expect(result.code, result.output).toBe(124);
    expect(result.exitAt - result.spawnAt, 'spawn-to-exit ms').toBeGreaterThanOrEqual(1_000);
    expect(result.exitAt - result.spawnAt, 'spawn-to-exit ms').toBeLessThanOrEqual(3_000);
    await expectAllDead(root, ['hold-alpha', 'hold-beta', 'stray-alpha'], result.output);
    expect(existsSync(marker(root, 'server-unit-ran')), 'a step after the expiry must never run').toBe(false);

    expect(result.output).toContain('⏰ TIMEOUT: pre-commit used its 1 s budget');
    expect(result.output).toContain('ADCP_PRECOMMIT_BUDGET_S');
    expectNamedWithElapsed(result.output, 'hold-alpha');
    expectNamedWithElapsed(result.output, 'hold-beta');

    const runDir = onlyRunDir(root, 'pre-commit', result.output);
    const meta = runJson(runDir);
    expect(meta.exit_code).toBe(124);
    expect(meta.budget).toMatchObject({ hook: 'pre-commit', seconds: 1, source: 'ADCP_PRECOMMIT_BUDGET_S' });
    expectExitNearDeadline(result, meta.budget);
    expect(timeOf(meta.ended_at) - timeOf(meta.budget.deadline_at)).toBeLessThanOrEqual(1_500);
    const running = JSON.stringify(meta.budget.running);
    expect(meta.budget.running).toHaveLength(2);
    expect(running).toContain('hold-alpha');
    expect(running).toContain('hold-beta');

    expect(stepFor(runDir, 'typecheck-hold-alpha').status).toBe('timed_out');
    expect(stepFor(runDir, 'typecheck-hold-beta').status).toBe('timed_out');
    const skipped = stepFor(runDir, 'precommit-server-unit.cjs');
    expect(skipped.status).toBe('skipped');
    expect(skipped.skipped_because).toMatch(/budget/);
  });
});

describe('pre-push hook budget (sh -e .husky/pre-push)', () => {
  it.each([
    { label: 'no budget variables', env: {} },
    { label: 'ADCP_PRECOMMIT_BUDGET_S=1, which pre-push ignores', env: { ADCP_PRECOMMIT_BUDGET_S: '1' } },
  ])('passes in a fixture repo under its 180 s default budget ($label)', async ({ env }) => {
    const root = fixtureRoot({
      scripts: { ...QUICK_PLAN, 'verify-version-sync': 'node scripts/verify-version-sync.cjs' },
      files: { ...QUICK_FILES, 'scripts/verify-version-sync.cjs': leaf.marks('verify-version-sync-ran') },
    });

    const result = await runHuskyHook(root, 'pre-push', hookEnv(root, env), ['origin', 'https://example.invalid/fixture.git']);

    expect(result.code, result.output).toBe(0);
    expect(existsSync(marker(root, 'verify-version-sync-ran')), 'the hook ran its first step').toBe(true);
    expect(budgetOf(root, 'pre-push', result.output)).toMatchObject({ hook: 'pre-push', seconds: 180, source: 'default' });
  });

  it('kills the hook script and everything it started at ADCP_PREPUSH_BUDGET_S, names the command it was running and exits 124', async () => {
    const root = fixtureRoot({
      scripts: { ...QUICK_PLAN, 'verify-version-sync': 'node scripts/verify-version-sync.cjs' },
      files: {
        ...QUICK_FILES,
        // As the storyboard queue does: a detached child (own group) that
        // ignores SIGTERM and holds the hook's output pipe.
        'scripts/verify-version-sync.cjs': leaf.holdsWithStray('verify-version-sync', 'stray-vvs'),
      },
    });

    const result = await runHuskyHook(
      root, 'pre-push', hookEnv(root, { ADCP_PREPUSH_BUDGET_S: '1' }), ['origin', 'https://example.invalid/fixture.git'],
    );

    expect(result.code, result.output).toBe(124);
    await expectAllDead(root, ['verify-version-sync', 'stray-vvs'], result.output);
    expect(result.output).toContain('⏰ TIMEOUT: pre-push used its 1 s budget');
    expectNamedWithElapsed(result.output, 'verify-version-sync');
    const budget = budgetOf(root, 'pre-push', result.output);
    expect(budget).toMatchObject({ hook: 'pre-push', seconds: 1, source: 'ADCP_PREPUSH_BUDGET_S' });
    expectExitNearDeadline(result, budget);
  });
});

describe('budget resolution through the runner CLI', () => {
  const PREPUSH_CMD = ['--name', 'pre-push', '--', 'node', 'scripts/typecheck-pass.cjs'];

  it.each([
    { hook: 'pre-commit', args: [], env: {}, seconds: 120, source: 'default' },
    { hook: 'pre-commit', args: [], env: { ADCP_HOOK_BUDGET_S: '7' }, seconds: 7, source: 'ADCP_HOOK_BUDGET_S' },
    { hook: 'pre-commit', args: [], env: { ADCP_HOOK_BUDGET_S: '7', ADCP_PRECOMMIT_BUDGET_S: '9' }, seconds: 9, source: 'ADCP_PRECOMMIT_BUDGET_S' },
    { hook: 'pre-commit', args: ['--budget-s', '11'], env: { ADCP_HOOK_BUDGET_S: '7', ADCP_PRECOMMIT_BUDGET_S: '9' }, seconds: 11, source: '--budget-s' },
    { hook: 'pre-commit', args: ['--name', 'pre-commit'], env: { ADCP_PREPUSH_BUDGET_S: '8' }, seconds: 120, source: 'default' },
    { hook: 'pre-push', args: PREPUSH_CMD, env: {}, seconds: 180, source: 'default' },
    { hook: 'pre-push', args: PREPUSH_CMD, env: { ADCP_HOOK_BUDGET_S: '7' }, seconds: 7, source: 'ADCP_HOOK_BUDGET_S' },
    { hook: 'pre-push', args: PREPUSH_CMD, env: { ADCP_HOOK_BUDGET_S: '7', ADCP_PREPUSH_BUDGET_S: '8' }, seconds: 8, source: 'ADCP_PREPUSH_BUDGET_S' },
    { hook: 'pre-push', args: PREPUSH_CMD, env: { ADCP_PRECOMMIT_BUDGET_S: '9' }, seconds: 180, source: 'default' },
    { hook: 'pre-push', args: ['--budget-s', '11', ...PREPUSH_CMD], env: { ADCP_PREPUSH_BUDGET_S: '8' }, seconds: 11, source: '--budget-s' },
  ] as const)('$hook: args $args env $env -> $seconds s from $source', async ({ hook, args, env, seconds, source }) => {
    const root = fixtureRoot({ scripts: QUICK_PLAN, files: QUICK_FILES });

    const result = await runRunner(root, [...args], hookEnv(root, env));

    expect(result.code, result.output).toBe(0);
    expect(existsSync(marker(root, 'pass-ran')), 'the step ran').toBe(true);
    expect(budgetOf(root, hook, result.output)).toMatchObject({ hook, seconds, source });
  });

  it('accepts a decimal budget and expires on it', async () => {
    const root = fixtureRoot({
      scripts: { precommit: 'node scripts/typecheck-hold.cjs' },
      files: { 'scripts/typecheck-hold.cjs': leaf.holds('hold') },
    });

    const result = await runRunner(root, [], hookEnv(root, { ADCP_HOOK_BUDGET_S: '0.5' }));

    expect(result.code, result.output).toBe(124);
    await expectAllDead(root, ['hold'], result.output);
    expect(result.output).toContain('⏰ TIMEOUT: pre-commit used its 0.5 s budget');
    const budget = budgetOf(root, 'pre-commit', result.output);
    expect(budget).toMatchObject({ hook: 'pre-commit', seconds: 0.5, source: 'ADCP_HOOK_BUDGET_S' });
    expectExitNearDeadline(result, budget);
  });

  const INVALID = ['abc', '0', '-1', ''];
  const invalidCases = [
    ...INVALID.map((value) => ({ name: 'ADCP_HOOK_BUDGET_S', value, args: [] as string[], env: { ADCP_HOOK_BUDGET_S: value } })),
    ...INVALID.map((value) => ({ name: 'ADCP_PRECOMMIT_BUDGET_S', value, args: [] as string[], env: { ADCP_PRECOMMIT_BUDGET_S: value } })),
    ...INVALID.map((value) => ({ name: 'ADCP_PREPUSH_BUDGET_S', value, args: PREPUSH_CMD, env: { ADCP_PREPUSH_BUDGET_S: value } })),
    ...INVALID.map((value) => ({ name: '--budget-s', value, args: ['--budget-s', value], env: {} })),
  ];

  it.each(invalidCases)('rejects $name=$value with exit 2 before any step starts', async ({ name, args, env }) => {
    const root = fixtureRoot({ scripts: QUICK_PLAN, files: QUICK_FILES });

    const result = await runRunner(root, [...args], hookEnv(root, env));

    expect(result.code, result.output).toBe(2);
    expect(result.output, 'the message names the variable or argument').toContain(name);
    expect(existsSync(marker(root, 'pass-ran')), 'no step ran').toBe(false);
    expect(existsSync(marker(root, 'image-check-ran')), 'no step ran').toBe(false);
  });
});

describe('hook --name <hook> -- CMD: the command as the single step under the hook budget', () => {
  it.each(['pre-commit', 'pre-push'] as const)('%s: runs CMD with its arguments verbatim and passes its exit code through', async (hook) => {
    const root = fixtureRoot({
      scripts: QUICK_PLAN,
      files: { ...QUICK_FILES, 'scripts/exit-with.cjs': leaf.exitsWith('exit-with') },
    });

    const result = await runRunner(
      root, ['--name', hook, '--', 'node', 'scripts/exit-with.cjs', '--code', '3', '--budget-s', 'x'], hookEnv(root),
    );

    expect(result.code, result.output).toBe(3);
    expect(existsSync(marker(root, 'exit-with.argv')), `CMD ran; output:\n${result.output}`).toBe(true);
    expect(JSON.parse(readFileSync(marker(root, 'exit-with.argv'), 'utf8'))).toEqual(['--code', '3', '--budget-s', 'x']);
    expect(existsSync(marker(root, 'pass-ran')), 'the pre-commit plan did not run').toBe(false);
    expect(existsSync(marker(root, 'image-check-ran')), 'the pre-commit plan did not run').toBe(false);
    const runDir = onlyRunDir(root, hook, result.output);
    const steps = stepReports(runDir);
    expect(steps, 'CMD is the only step').toHaveLength(1);
    expect(steps[0]).toMatchObject({ exit_code: 3, status: 'failed' });
    expect(runJson(runDir).budget).toMatchObject({ hook, seconds: hook === 'pre-commit' ? 120 : 180, source: 'default' });
  });

  it.each(['pre-commit', 'pre-push'] as const)('%s: kills CMD at --budget-s, names it with its elapsed time and exits 124', async (hook) => {
    const root = fixtureRoot({
      scripts: QUICK_PLAN,
      files: { ...QUICK_FILES, 'scripts/hold.cjs': leaf.holds('hold') },
    });

    const result = await runRunner(root, ['--name', hook, '--budget-s', '0.5', '--', 'node', 'scripts/hold.cjs'], hookEnv(root));

    expect(result.code, result.output).toBe(124);
    await expectAllDead(root, ['hold'], result.output);
    expect(result.output).toContain(`⏰ TIMEOUT: ${hook} used its 0.5 s budget`);
    expectNamedWithElapsed(result.output, 'hold.cjs');
    const runDir = onlyRunDir(root, hook, result.output);
    const meta = runJson(runDir);
    expect(meta.exit_code).toBe(124);
    expect(meta.budget).toMatchObject({ hook, seconds: 0.5, source: '--budget-s' });
    expectExitNearDeadline(result, meta.budget);
    expect(stepFor(runDir, 'hold.cjs').status).toBe('timed_out');
  });
});
