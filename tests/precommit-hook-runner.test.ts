// Behavior of the concurrent pre-commit hook runner, driven through its CLI:
//   node scripts/profile-precommit.mjs hook [--root DIR] [--keep-going]
// Each case builds a throwaway repo root (package.json + tiny leaf scripts),
// runs the real CLI against it and asserts on what a user sees: the exit code,
// the terminal output, the files leaves leave behind and the run directory
// (<root>/.hook-runs/<stamp>-hook/). Nothing here asserts on wall-clock time;
// the sleeps and bounded waits inside the fixtures only make a scheduling
// error observable (a leaf that runs too early or too late fails). Every
// bounded wait ends well inside the 10 s test timeout (vitest.config.ts), so a
// scheduling fault fails with its own message, not with a test timeout.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import gitObjectFixture from './helpers/git-object-fixture.cjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILER = join(REPO_ROOT, 'scripts', 'profile-precommit.mjs');
const NODE = process.execPath;
const NPM_CLI = resolve(dirname(NODE), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const REAL_BASH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

// ------------------------------------------------------------------ fixtures

// Shared helper every fixture leaf requires. Markers live in <root>/markers.
const FIXTURE_LIB = `
const fs = require('node:fs');
const path = require('node:path');
const MARKERS = path.join(__dirname, '..', 'markers');
const file = (name) => path.join(MARKERS, name);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const has = (name) => fs.existsSync(file(name));
const mark = (name, text = '') => fs.writeFileSync(file(name), String(text));
const read = (name) => fs.readFileSync(file(name), 'utf8');
const event = (text) => fs.appendFileSync(file('events.log'), text + '\\n');
// Bounded wait: true as soon as pred() holds, false after ms.
const waitFor = (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; sleep(50); }
  return pred();
};
const step = (name, ms) => { event('start ' + name); sleep(ms); event('end ' + name); };
const holdWithPid = (name, ms) => { mark(name + '.pid', process.pid); setTimeout(() => {}, ms); };
module.exports = { sleep, alive, has, mark, read, event, waitFor, step, holdWithPid };
`;

const LIB = "require('../scripts/fixture-lib.cjs')";
const LIB_FROM_SCRIPTS = "require('./fixture-lib.cjs')";


// Leaf files, built from the shared helper.
const leaf = {
  /** node --test file that only records that it ran. */
  passes: (marker: string) => `${LIB}.mark(${JSON.stringify(marker)});\n`,
  /** Records start/end events around a short busy period. */
  step: (name: string, ms = 300) => `${LIB}.step(${JSON.stringify(name)}, ${ms});\n`,
  /** Marks itself started, then fails unless the other leaf starts within 5 s. */
  rendezvous: (self: string, other: string) => `
const lib = ${LIB};
lib.mark(${JSON.stringify(`${self}-started`)});
if (!lib.waitFor(() => lib.has(${JSON.stringify(`${other}-started`)}), 5000)) {
  console.error(${JSON.stringify(`${self}: ${other} never started while ${self} was running`)});
  process.exit(1);
}
lib.mark(${JSON.stringify(`${self}-saw-${other}`)});
`,
  /** Long-running leaf (scripts/ dir) that publishes its pid. */
  hold: (name: string, ms: number) => `${LIB_FROM_SCRIPTS}.holdWithPid(${JSON.stringify(name)}, ${ms});\n`,
  /**
   * Leaf (scripts/ dir, ES module) that forks scripts/worker.cjs, as a vitest
   * forks pool does, and SIGKILLs itself once the worker is up, as an OOM kill
   * or a crash would end it. The worker keeps a timer and its inherited stdio.
   */
  crashingMain: () => [
    "import { fork } from 'node:child_process';",
    "import path from 'node:path';",
    "const worker = fork(path.join(import.meta.dirname, 'worker.cjs'));",
    "worker.on('message', () => process.kill(process.pid, 'SIGKILL'));",
    '',
  ].join('\n'),
  worker: () => `${LIB_FROM_SCRIPTS}.holdWithPid('worker', 60_000);\nprocess.send('ready');\n`,
};

const roots: string[] = [];

interface FixtureOptions {
  scripts: Record<string, string>;
  files?: Record<string, string>;
}

/** A throwaway git repo root with package.json scripts and leaf files. */
function fixtureRoot({ scripts, files = {} }: FixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'precommit-hook-runner-'));
  roots.push(root);
  for (const dir of ['markers', 'scripts', 'tests']) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'hook-runner-fixture', version: '0.0.0', private: true, scripts }, null, 2)
  );
  copyFileSync(join(REPO_ROOT, 'scripts', 'with-timeout.sh'), join(root, 'scripts', 'with-timeout.sh'));
  writeFileSync(join(root, 'scripts', 'fixture-lib.cjs'), FIXTURE_LIB);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/** Environment for child processes: no inherited budget scale, hook switches or npm state. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|ADCP_TIMEOUT_SCALE$|ADCP_PRECOMMIT_|ADCP_HOOK_RUNS_KEEP$|NODE_OPTIONS$|VITEST|HUSKY)/i.test(key)) continue;
    env[key] = value;
  }
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
}

interface HookRun {
  child: ChildProcess;
  exited: () => boolean;
  output: () => string;
  done: Promise<HookResult>;
}

/** Spawns the hook runner CLI with cwd = root; SIGKILLs it if it outlives guardMs (inside the test timeout). */
function startHook(root: string, { env = childEnv(), args = [] as string[], guardMs = 8_000 } = {}): HookRun {
  const child = spawn(NODE, [PROFILER, 'hook', '--root', root, ...args], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let output = '';
  let exited = false;
  child.stdout!.on('data', (chunk) => { stdout += chunk; output += chunk; });
  child.stderr!.on('data', (chunk) => { stderr += chunk; output += chunk; });
  const done = new Promise<HookResult>((resolveDone) => {
    const guard = setTimeout(() => child.kill('SIGKILL'), guardMs);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolveDone({ code, signal, stdout, stderr, output });
    };
    child.on('exit', (code, signal) => {
      exited = true;
      // Leaves never share the runner's pipes, so 'close' follows promptly;
      // the fallback only keeps a stray pipe holder from hanging the test.
      const fallback = setTimeout(() => finish(code, signal), 2_000);
      child.on('close', () => { clearTimeout(fallback); finish(code, signal); });
    });
  });
  return { child, exited: () => exited, output: () => output, done };
}

/** Runs command with cwd = root in its own process group; kills the group when it exits. */
function runOracle(
  root: string, command: string, args: string[], env: NodeJS.ProcessEnv, logName: string,
): Promise<number | null> {
  const out = openSync(join(root, `${logName}.out.log`), 'a');
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  return new Promise((resolveExit) => {
    child.on('exit', (code) => {
      // Nothing the oracle's commands started may outlive them.
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already gone */ }
      resolveExit(code);
    });
  });
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

const marker = (root: string, name: string) => join(root, 'markers', name);

function hookRunDirs(root: string): string[] {
  const base = join(root, '.hook-runs');
  return existsSync(base) ? readdirSync(base).filter((n) => /-hook$/.test(n)).sort() : [];
}

function onlyHookRun(root: string): string {
  const dirs = hookRunDirs(root);
  expect(dirs, 'exactly one <stamp>-hook run directory').toHaveLength(1);
  return join(root, '.hook-runs', dirs[0]);
}

interface StepReport {
  dir: string;
  report: Record<string, unknown>;
}

/** The single NN-<name>/report.json whose content mentions needle (a leaf's command text). */
function stepFor(runDir: string, needle: string): StepReport {
  const steps = readdirSync(runDir)
    .filter((n) => /^\d{2}-/.test(n) && existsSync(join(runDir, n, 'report.json')))
    .map((n) => ({ dir: join(runDir, n), text: readFileSync(join(runDir, n, 'report.json'), 'utf8') }))
    .filter((s) => s.text.includes(needle));
  expect(steps.map((s) => s.dir), `one step report mentions ${needle}`).toHaveLength(1);
  return { dir: steps[0].dir, report: JSON.parse(steps[0].text) };
}

// The fixture roots are git repositories, and the hook runner under test runs
// git in them; every child inherits process.env. Inside a linked-worktree hook
// that carries GIT_DIR=<repo>/.git/worktrees/<name>, and `git init` in a
// fixture would then write core.bare=true into the caller's shared config.
// Run the file under the shared fixture git environment instead.
let restoreGitEnv = () => {};
beforeAll(() => { restoreGitEnv = gitObjectFixture.isolateGitEnv({ identity: false }); });
afterAll(() => restoreGitEnv());

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Leaves that publish a pid must not outlive their test, whatever the runner did.
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

// ------------------------------------------------------------------- oracle

// The npm call the hook's plan starts from (scripts/profile-precommit/plan.mjs
// PLAN_ROOTS): the sequential .husky/pre-commit ran `npm run precommit`, and
// the image check, which is a test of the precommit:checks vitest project
// since tp-jyw.51.
const ORACLE_NPM_ARGS = ['run', 'precommit'];
const ORACLE_CACHE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'precommit-hook-oracle');
const NPM_REPLAY = join(REPO_ROOT, 'tests', 'helpers', 'npm-call-replay.cjs');

interface LeafShims { bin: string; shims: Record<string, string> }

/**
 * Argv-logging shims for every leaf executable, in parent/shims-<SHA-256 of
 * their text>. npm is the real npm ($HOOK_SHIM_NPM_CLI) on the real node, or
 * a recorder for npm-call-replay.cjs, so nested `npm run` chains expand as
 * npm does; bash runs with-timeout.sh for
 * real and logs everything else. The shims log to $HOOK_SHIM_LOG and take
 * no path from a run, so one directory serves every run. macOS assesses a
 * new executable on its first exec (0.1-0.2 s each on an idle laptop); a
 * shared directory pays that once instead of in every test.
 */
function writeLeafShims(parent = ORACLE_CACHE_DIR): LeafShims {
  const logShim = (name: string, prelude = '') => [
    '#!/bin/sh',
    prelude,
    `line=${name}`,
    'for arg in "$@"; do line="$line $arg"; done',
    'printf \'%s\\n\' "$line" >> "$HOOK_SHIM_LOG"',
    'exit 0',
    '',
  ].join('\n');
  const shims: Record<string, string> = {
    node: logShim('node'),
    vitest: logShim('vitest'),
    tsc: logShim('tsc'),
    npx: logShim('npx'),
    bash: logShim('bash', `if [ "$1" = scripts/with-timeout.sh ]; then exec ${JSON.stringify(REAL_BASH)} "$@"; fi`),
    // Real npm, unless $HOOK_SHIM_NPM_QUEUE names a queue: then it records
    // the call (cwd, argv, env) for tests/helpers/npm-call-replay.cjs.
    npm: [
      '#!/bin/sh',
      `[ -n "\${HOOK_SHIM_NPM_QUEUE-}" ] || exec ${JSON.stringify(NODE)} "$HOOK_SHIM_NPM_CLI" "$@"`,
      'call=$(mktemp "$HOOK_SHIM_NPM_QUEUE/call.XXXXXX") || exit 1',
      'printf \'%s\\0\' "$(pwd -P)" "$#" "$@" > "$call" && env -0 >> "$call"',
      '',
    ].join('\n'),
  };
  const bin = join(parent, `shims-${createHash('sha256').update(JSON.stringify(shims)).digest('hex')}`);
  if (!existsSync(bin)) {
    // Built aside and renamed into place whole; a concurrent builder that
    // loses the rename uses the winner's identical directory.
    mkdirSync(parent, { recursive: true });
    const tmp = mkdtempSync(`${bin}.tmp-`);
    for (const [name, text] of Object.entries(shims)) {
      writeFileSync(join(tmp, name), text);
      chmodSync(join(tmp, name), 0o755);
    }
    try { renameSync(tmp, bin); } catch { rmSync(tmp, { recursive: true, force: true }); }
  }
  return { bin, shims };
}

/**
 * Environment for a run through the shims: shims first on PATH, leaves logged
 * to log. With queue, the npm shim records its calls there instead of running npm.
 */
const shimEnv = (bin: string, log: string, { npmCli = NPM_CLI, queue = '' } = {}) => childEnv({
  PATH: `${bin}:${process.env.PATH}`, HOOK_SHIM_LOG: log, HOOK_SHIM_NPM_CLI: npmCli,
  ...(queue ? { HOOK_SHIM_NPM_QUEUE: queue } : {}),
});

/** The sorted leaf lines that ORACLE_NPM_ARGS run in root, one real npm process per npm call. */
async function npmProcessExpansion(root: string, bin: string, npmCli = NPM_CLI): Promise<string[]> {
  const log = join(root, 'npm-process-leaves.log');
  const call = ['npm', ...ORACLE_NPM_ARGS].join(' ');
  expect(await runOracle(root, NODE, [npmCli, ...ORACLE_NPM_ARGS], shimEnv(bin, log, { npmCli }), 'npm-process'), call).toBe(0);
  return lines(log).sort();
}

/**
 * The sorted leaf lines that ORACLE_NPM_ARGS run in root, with every npm call
 * replayed by npm's own code in one process (tests/helpers/npm-call-replay.cjs).
 */
async function npmReplayExpansion(root: string, bin: string, npmCli = NPM_CLI): Promise<string[]> {
  const log = join(root, 'npm-replay-leaves.log');
  const queue = mkdtempSync(join(root, 'npm-calls-'));
  const env = shimEnv(bin, log, { npmCli, queue });
  expect(await runOracle(root, NODE, [NPM_REPLAY, npmCli, ...ORACLE_NPM_ARGS], env, 'npm-replay'), 'npm-call-replay').toBe(0);
  return lines(log).sort();
}

interface OracleOptions { npmCli?: string; cacheDir?: string }

/**
 * The cache entry for npm's expansion of ORACLE_NPM_ARGS in root:
 * cacheDir/<SHA-256>.json over exactly what the expansion depends on, root's
 * package.json scripts and scripts/with-timeout.sh, the npm version at
 * npmCli, ORACLE_NPM_ARGS, the shims and the replay helper.
 */
function oracleCacheEntry(
  root: string, shims: Record<string, string>, { npmCli = NPM_CLI, cacheDir = ORACLE_CACHE_DIR }: OracleOptions = {},
): string {
  const key = createHash('sha256').update(JSON.stringify({
    scripts: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {},
    withTimeout: readFileSync(join(root, 'scripts', 'with-timeout.sh'), 'utf8'),
    npmVersion: JSON.parse(readFileSync(resolve(dirname(npmCli), '..', 'package.json'), 'utf8')).version,
    npmArgs: ORACLE_NPM_ARGS,
    shims,
    replay: readFileSync(NPM_REPLAY, 'utf8'),
  })).digest('hex');
  return join(cacheDir, `${key}.json`);
}

/**
 * The sorted leaf lines that ORACLE_NPM_ARGS run in root through the shims,
 * under the real npm at npmCli. Read from oracleCacheEntry() when present;
 * on a miss, npm's own code expands it in one process (npmReplayExpansion),
 * instead of the 15 npm processes, one after another, that npm itself starts
 * for the real package.json.
 */
async function npmExpansion(
  root: string, { bin, shims }: LeafShims, options: OracleOptions = {},
): Promise<{ leaves: string[]; cached: boolean }> {
  const { npmCli = NPM_CLI } = options;
  const entry = oracleCacheEntry(root, shims, options);
  try {
    const { leaves } = JSON.parse(readFileSync(entry, 'utf8'));
    if (Array.isArray(leaves) && leaves.every((l) => typeof l === 'string')) return { leaves, cached: true };
  } catch { /* miss */ }

  const leaves = await npmReplayExpansion(root, bin, npmCli);
  // Concurrent writers each rename a complete file into place.
  mkdirSync(dirname(entry), { recursive: true });
  const tmp = `${entry}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ leaves }));
  renameSync(tmp, entry);
  return { leaves, cached: false };
}

// --------------------------------------------------------------------- tests

describe('pre-commit hook runner: same commands as the sequential hook', () => {
  it('runs exactly the leaf commands that npm run precommit runs, on the real package.json', async () => {
    expect(existsSync(NPM_CLI), `npm-cli.js next to ${NODE}`).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'precommit-hook-oracle-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
    copyFileSync(join(REPO_ROOT, 'scripts', 'with-timeout.sh'), join(root, 'scripts', 'with-timeout.sh'));
    execFileSync('git', ['init', '-q'], { cwd: root });

    // Oracle: what npm runs for the `npm run precommit` .husky/pre-commit ran.
    const shimmed = writeLeafShims();
    const { leaves: oracle } = await npmExpansion(root, shimmed);
    // The hook's checks are one vitest run over the root config's
    // precommit:* projects (tests/vitest-hook-projects.test.ts pins which
    // files each project runs).
    expect(oracle).toContain('vitest run --project precommit:*');

    const hookLog = join(root, 'hook-leaves.log');
    const result = await startHook(root, { env: shimEnv(shimmed.bin, hookLog) }).done;
    expect(result.code, result.output).toBe(0);
    expect(lines(hookLog).sort()).toEqual(oracle);
  });

  it('replays nested npm calls in one process with the same leaves as one npm process per call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precommit-hook-oracle-replay-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(REPO_ROOT, 'scripts', 'with-timeout.sh'), join(root, 'scripts', 'with-timeout.sh'));
    // The constructs the real precommit chain uses (a nested `npm run` behind
    // the with-timeout wrapper, `&&`), plus what npm does around a script: pre
    // and post scripts, arguments after `--` and a flag before the script name.
    // `npm run precommit` comes from the helper's arguments and its two calls
    // from the recorder's queue, so both ways a call reaches a replay run. Three real npm processes, one after another,
    // are the reference: one per call.
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'oracle-replay-fixture', version: '0.0.0', private: true, scripts: {
        precommit: 'bash scripts/with-timeout.sh 300 npm run unit && npm run --if-present lint -- --fix',
        unit: 'node --test a.test.cjs && vitest run --dir tests/',
        prelint: 'node scripts/prelint.cjs',
        lint: 'tsc --noEmit',
        postlint: 'npx eslint .',
      },
    }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const { bin } = writeLeafShims();

    const replayed = await npmReplayExpansion(root, bin);
    expect(replayed).toEqual([
      'node --test a.test.cjs',
      'node scripts/prelint.cjs',
      'npx eslint .',
      'tsc --noEmit --fix',
      'vitest run --dir tests/',
    ]);
    expect(await npmProcessExpansion(root, bin)).toEqual(replayed);
  });

  it('keys the cached oracle on the scripts, with-timeout.sh and the npm version, and expands with npm only on a miss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precommit-hook-oracle-cache-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts'));
    const withTimeout = readFileSync(join(REPO_ROOT, 'scripts', 'with-timeout.sh'), 'utf8');
    const writeWithTimeout = (text: string) => writeFileSync(join(root, 'scripts', 'with-timeout.sh'), text);
    const writeScripts = (scripts: Record<string, string>) => writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'oracle-cache-fixture', version: '0.0.0', private: true, scripts }),
    );
    // An npm installation whose version the test sets: its CLI and code are the real ones.
    const npmDir = join(root, 'npm');
    const realNpmRoot = resolve(dirname(NPM_CLI), '..');
    mkdirSync(join(npmDir, 'bin'), { recursive: true });
    const setNpmVersion = (version: string) => writeFileSync(join(npmDir, 'package.json'), JSON.stringify({ name: 'npm', version }));
    writeFileSync(join(npmDir, 'bin', 'npm-cli.js'), `require(${JSON.stringify(NPM_CLI)});\n`);
    for (const dir of ['lib', 'node_modules']) symlinkSync(join(realNpmRoot, dir), join(npmDir, dir));
    const shimmed = writeLeafShims();
    const options = { npmCli: join(npmDir, 'bin', 'npm-cli.js'), cacheDir: join(root, 'cache') };
    const entry = () => oracleCacheEntry(root, shimmed.shims, options);
    const scripts = { precommit: 'vitest run a' };
    writeScripts(scripts);
    writeWithTimeout(withTimeout);
    setNpmVersion('11.0.0-fixture.1');

    const leaves = ['vitest run a'];
    expect(await npmExpansion(root, shimmed, options)).toEqual({ leaves, cached: false });
    expect(existsSync(entry())).toBe(true);
    expect(await npmExpansion(root, shimmed, options)).toEqual({ leaves, cached: true });

    // Each input on its own moves the entry, so a change misses; restoring it hits again.
    const base = entry();
    writeScripts({ precommit: 'vitest run b' });
    expect(entry(), 'a changed script').not.toBe(base);
    expect(existsSync(entry())).toBe(false);
    writeScripts(scripts);
    expect(entry()).toBe(base);

    writeWithTimeout(`${withTimeout}# changed\n`);
    expect(entry(), 'a changed with-timeout.sh').not.toBe(base);
    writeWithTimeout(withTimeout);
    expect(entry()).toBe(base);

    setNpmVersion('11.0.0-fixture.2');
    expect(entry(), 'another npm version').not.toBe(base);
    setNpmVersion('11.0.0-fixture.1');
    expect(entry()).toBe(base);
  });
});

describe('pre-commit hook runner: scheduling', () => {
  it('runs concurrency-safe leaves at the same time', async () => {
    const root = fixtureRoot({
      scripts: {
        precommit: 'npm run light',
        light: 'node --test tests/rv-a.test.cjs && node --test tests/rv-b.test.cjs',
      },
      files: {
        'tests/rv-a.test.cjs': leaf.rendezvous('rv-a', 'rv-b'),
        'tests/rv-b.test.cjs': leaf.rendezvous('rv-b', 'rv-a'),
      },
    });

    const result = await startHook(root).done;

    expect(result.code, result.output).toBe(0);
    expect(existsSync(marker(root, 'rv-a-saw-rv-b'))).toBe(true);
    expect(existsSync(marker(root, 'rv-b-saw-rv-a'))).toBe(true);
  });

  it('collects every result in a failing phase, skips the server phase and exits with the failure code', async () => {
    const root = fixtureRoot({
      scripts: {
        precommit: 'npm run light && node scripts/precommit-server-unit.cjs',
        light: 'node scripts/generate-governance-jws-vectors.mjs --check && node --test tests/collect-all-pass.test.cjs',
      },
      files: {
        // Allowlisted read-only leaf: fails with a distinctive message and exit 3.
        'scripts/generate-governance-jws-vectors.mjs': [
          "import { createRequire } from 'node:module';",
          "const lib = createRequire(import.meta.url)('./fixture-lib.cjs');",
          "lib.mark('jws-check.pid', process.pid);",
          "console.error('FIXTURE_JWS_FAILURE_7f3a: governance vectors are out of date');",
          'process.exit(3);',
          '',
        ].join('\n'),
        // Sibling in the same phase: finishes only after the failing leaf has exited,
        // so it completes only if the runner lets the phase run to the end.
        'tests/collect-all-pass.test.cjs': `
const lib = ${LIB};
const exitedFirst = lib.waitFor(() => lib.has('jws-check.pid') && !lib.alive(Number(lib.read('jws-check.pid'))), 5000);
if (!exitedFirst) { console.error('the failing sibling never ran and exited'); process.exit(1); }
lib.mark('pass-done');
`,
        'scripts/precommit-server-unit.cjs': `${LIB_FROM_SCRIPTS}.mark('server-unit-ran');\n`,
      },
    });

    const result = await startHook(root).done;

    expect(result.code, result.output).toBe(3);
    expect(existsSync(marker(root, 'pass-done')), 'sibling leaf ran to completion').toBe(true);
    expect(existsSync(marker(root, 'server-unit-ran')), 'server phase must not run after a failure').toBe(false);
    expect(result.output).toContain('FIXTURE_JWS_FAILURE_7f3a');

    const runDir = onlyHookRun(root);
    expect(existsSync(join(runDir, 'run.json'))).toBe(true);
    expect(existsSync(join(runDir, 'summary.json'))).toBe(true);
    const failed = stepFor(runDir, 'generate-governance-jws-vectors');
    expect(failed.report).toMatchObject({ exit_code: 3, status: 'failed' });
    expect(typeof failed.report.name).toBe('string');
    expect(typeof failed.report.wall_s).toBe('number');
    expect(readFileSync(join(failed.dir, 'stderr.log'), 'utf8')).toContain('FIXTURE_JWS_FAILURE_7f3a');
    expect(existsSync(join(failed.dir, 'stdout.log'))).toBe(true);
    expect(stepFor(runDir, 'collect-all-pass.test.cjs').report).toMatchObject({ exit_code: 0, status: 'passed' });
    expect(stepFor(runDir, 'precommit-server-unit.cjs').report).toMatchObject({ status: 'skipped' });
  });

  it('runs any other leaf alone, after the leaves before it and before the leaves after it', async () => {
    const root = fixtureRoot({
      scripts: {
        precommit: 'npm run before && node scripts/barrier.cjs && npm run after',
        before: 'node --test tests/l1.test.cjs && node --test tests/l2.test.cjs',
        after: 'node --test tests/l3.test.cjs',
      },
      files: {
        'tests/l1.test.cjs': leaf.step('l1'),
        'tests/l2.test.cjs': leaf.step('l2'),
        'scripts/barrier.cjs': `${LIB_FROM_SCRIPTS}.step('barrier', 300);\n`,
        'tests/l3.test.cjs': leaf.step('l3'),
      },
    });

    const result = await startHook(root).done;

    expect(result.code, result.output).toBe(0);
    const events = lines(marker(root, 'events.log'));
    const at = (event: string) => {
      const index = events.indexOf(event);
      expect(index, `${event} in ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('start barrier'), JSON.stringify(events)).toBeGreaterThan(Math.max(at('end l1'), at('end l2')));
    expect(at('start l3'), JSON.stringify(events)).toBeGreaterThan(at('end barrier'));
    expect(events).toHaveLength(8);
  });
});

describe('pre-commit hook runner: budgets, signals and advisory checks', () => {
  // Budgets are hook-wide (tests/hook-budget.test.ts); a per-step
  // with-timeout wrapper in the chain must not come back.
  it('rejects a precommit chain that wraps a step in with-timeout.sh, before any step runs', async () => {
    const root = fixtureRoot({
      scripts: {
        precommit: 'node --test tests/before.test.cjs && bash scripts/with-timeout.sh 1 npm run slow',
        slow: 'node scripts/typecheck-slow.cjs',
      },
      files: {
        'tests/before.test.cjs': leaf.passes('before-ran'),
        'scripts/typecheck-slow.cjs': `${LIB_FROM_SCRIPTS}.mark('slow-ran');\n`,
      },
    });

    const result = await startHook(root, { env: childEnv() }).done;

    expect(result.code, result.output).not.toBe(0);
    expect(result.code, result.output).not.toBeNull();
    expect(result.output).toMatch(/budgets are hook-wide/);
    expect(result.output).toContain('with-timeout');
    expect(existsSync(marker(root, 'before-ran')), 'no step runs when the plan is rejected').toBe(false);
    expect(existsSync(marker(root, 'slow-ran')), 'no step runs when the plan is rejected').toBe(false);
  });

  it('forwards SIGINT to running leaves, waits for them and exits 130', async () => {
    const root = fixtureRoot({
      scripts: { precommit: 'node scripts/long-leaf.cjs' },
      files: { 'scripts/long-leaf.cjs': leaf.hold('long-leaf', 60_000) },
    });
    const pidFile = marker(root, 'long-leaf.pid');

    const run = startHook(root);
    const pidWritten = () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0;
    await waitUntil(() => pidWritten() || run.exited(), 5_000);
    expect(pidWritten(), `the leaf never started; runner output:\n${run.output()}`).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    run.child.kill('SIGINT');
    const result = await run.done;

    // Grace for the OS to reap a leaf reparented after its shell exited.
    await waitUntil(() => !alive(pid), 1_000);
    expect(alive(pid), `leaf ${pid} is still running after the runner exited`).toBe(false);
    expect(result.code, result.output).toBe(130);
    expect(stepFor(onlyHookRun(root), 'long-leaf.cjs').report).toMatchObject({ status: 'interrupted' });
  });

  // A leaf whose main process dies on its own leaves its forked workers in
  // the leaf's process group; nothing else would ever stop them.
  it.each([
    {
      output: 'streamed to the terminal',
      scripts: { precommit: 'node scripts/crash-main.mjs' },
      main: 'scripts/crash-main.mjs',
    },
    {
      output: 'written to files beside another leaf',
      scripts: { precommit: 'node scripts/generate-governance-jws-vectors.mjs --check && node --test tests/pass.test.cjs' },
      main: 'scripts/generate-governance-jws-vectors.mjs',
    },
  ])('kills the rest of a leaf\'s process group when its main process is SIGKILLed (output $output)', async ({ scripts, main }) => {
    const root = fixtureRoot({
      scripts,
      files: {
        [main]: leaf.crashingMain(),
        'scripts/worker.cjs': leaf.worker(),
        'tests/pass.test.cjs': leaf.passes('pass-ran'),
      },
    });
    const pidFile = marker(root, 'worker.pid');

    const result = await startHook(root).done;

    expect(existsSync(pidFile), `the worker never started; runner output:\n${result.output}`).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid), `worker ${pid} outlived its leaf`).toBe(false);
    expect(result.code, result.output).toBe(137);
    expect(stepFor(onlyHookRun(root), main.split('/')[1]).report).toMatchObject({ exit_code: 137, status: 'failed' });
  });

  it('keeps only the newest ADCP_HOOK_RUNS_KEEP hook runs and never prunes other run directories', async () => {
    const root = fixtureRoot({
      scripts: { precommit: 'node --test tests/pass.test.cjs' },
      files: { 'tests/pass.test.cjs': leaf.passes('pass-ran') },
    });
    const profileRun = join(root, '.hook-runs', '20200101T000000Z-baseline');
    mkdirSync(profileRun, { recursive: true });
    writeFileSync(join(profileRun, 'run.json'), '{}');

    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      // Back-to-back runs: run stamps carry milliseconds and a collision
      // suffix, so each run gets its own directory without waiting.
      const before = new Set(hookRunDirs(root));
      const result = await startHook(root, { env: childEnv({ ADCP_HOOK_RUNS_KEEP: '2' }) }).done;
      expect(result.code, result.output).toBe(0);
      const added = hookRunDirs(root).filter((d) => !before.has(d));
      expect(added, `run ${i + 1} created one hook run directory`).toHaveLength(1);
      created.push(added[0]);
    }

    expect(hookRunDirs(root)).toEqual(created.slice(1).sort());
    expect(existsSync(join(profileRun, 'run.json')), 'non-hook run directories are never pruned').toBe(true);
  });
});
