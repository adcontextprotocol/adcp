// `profile-precommit run --cpu-prof --heap-prof` must profile the test files
// of a vitest leaf that runs on the forks pool, as the root suite does.
//
// vitest stops a forks-pool worker with SIGTERM once it answers the stop
// request, and with SIGKILL 500 ms later. Node writes a --cpu-prof or
// --heap-prof profile at exit, so a worker whose exit takes longer than that,
// as on a loaded machine, lost its profiles. Each worker now writes them when
// the stop request arrives (scripts/profile-precommit/vitest-worker-profiler.mjs).
// The fixture's worker makes its exit slower than the SIGKILL delay: an exit
// listener sleeps 1.5 s without using CPU, so the case fails the same way on
// an idle machine as the old profiler did under load. The case runs the real
// CLI against a throwaway root with one test file and reads the profiles it
// writes.
//
// Node only logs a profile it cannot write and exits 0, so on a full disk the
// profile is simply missing. The case first requires the step to report no
// failed profile write (report.json profile_write_errors), and every message
// names the free space on the root's volume.
//
// Work decides the outcome, not wall time. The marker function does a fixed
// amount of work: on a loaded machine a time-boxed loop can get almost no CPU
// in its window, and then neither sampler records it. The profiler run is
// bounded by CPU time, 5 s per process (RLIMIT_CPU, which every process it
// starts inherits): a process that spins is killed with SIGXCPU however busy
// the machine is, and a run that is merely slow under load is not. A run that
// hangs without using CPU ends at the 10 s test timeout (vitest.config.ts),
// and afterEach stops it.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import gitObjectFixture from './helpers/git-object-fixture.cjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILER = join(REPO_ROOT, 'scripts', 'profile-precommit.mjs');
// Runs a command with every process it starts limited to N s of CPU.
const CPU_LIMIT = join(REPO_ROOT, 'tests', 'fixtures', 'cpu-limit.sh');
const NODE = process.execPath;
// Named so it can be found in a profile: it runs only in the test file.
const MARKER_FUNCTION = 'profiledInForksWorker';

const dirs: string[] = [];
const profilerGroups: number[] = [];
afterEach(() => {
  // A profiler run cut off by the test timeout must not keep running. SIGTERM,
  // not SIGKILL: the runner forwards it to the leaves it started in groups of
  // their own.
  for (const pgid of profilerGroups.splice(0)) {
    try { process.kill(-pgid, 'SIGTERM'); } catch { /* group gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The profiler runs git in the throwaway root; inside a hook the inherited
// GIT_DIR must not reach it (tests/helpers/git-object-fixture.cjs).
let restoreGitEnv = () => {};
beforeAll(() => { restoreGitEnv = gitObjectFixture.isolateGitEnv({ identity: false }); });
afterAll(() => restoreGitEnv());

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|NODE_OPTIONS$|VITEST|ADCP_PRECOMMIT_|ADCP_VITEST_|HUSKY)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Free space on dir's volume, for failure messages. */
function freeSpace(dir: string): string {
  const { bavail, bsize } = statfsSync(dir);
  return `${Math.round((bavail * bsize) / 2 ** 20)} MB free on the volume of ${dir}`;
}

/** The files in dir, for failure messages. */
function listing(dir: string): string {
  try { return readdirSync(dir).join(', ') || '(empty)'; } catch (error) { return (error as Error).message; }
}

interface ProfilerRun { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/**
 * Runs the profiler CLI in its own process group, every process of the run
 * limited to cpuSeconds of CPU time, and resolves when it exits.
 */
function runProfiler(args: string[], cwd: string, cpuSeconds: number): Promise<ProfilerRun> {
  return new Promise((resolveRun) => {
    const child = spawn(CPU_LIMIT, [String(cpuSeconds), NODE, PROFILER, ...args], {
      cwd, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    profilerGroups.push(child.pid!);
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => resolveRun({ status: null, signal: null, stdout, stderr: `${stderr}${String(error)}` }));
    child.once('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
}

/** Profile files under dir whose text names MARKER_FUNCTION. */
function profilesNamingMarker(dir: string, suffix: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(suffix)); } catch { return []; }
  return names.filter((n) => readFileSync(join(dir, n), 'utf8').includes(`"functionName":"${MARKER_FUNCTION}"`));
}

describe('profile-precommit run', () => {
  it('writes CPU and heap profiles for the test files of a forks-pool vitest leaf, even when the worker exits slowly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-precommit-forks-'));
    dirs.push(root);
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tests'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'scripts', 'check-image-quality.sh'), '#!/bin/bash\nexit 0\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'profile-precommit-forks-fixture', version: '0.0.0', private: true,
      scripts: { precommit: 'npm run test:unit', 'test:unit': 'vitest run --dir tests/ --pool=forks' },
    }, null, 2));
    // A fixed amount of work: about 30 MB of allocations kept reachable (the
    // heap profile lists live allocations only), some 60 intervals of the
    // heap sampler's 512 KiB, then a fixed loop over them that the CPU sampler
    // records about 70 times on an idle machine. Load stretches the work and
    // so adds CPU samples; it never removes any.
    writeFileSync(join(root, 'tests', 'worker.test.ts'), [
      "import { expect, it } from 'vitest';",
      'const kept: { index: number; text: string }[] = [];',
      `function ${MARKER_FUNCTION}() {`,
      '  for (let index = 0; index < 400_000; index++) kept.push({ index, text: String(index) });',
      '  let checksum = 0;',
      '  for (let round = 0; round < 40; round++) for (let index = 0; index < kept.length; index++) checksum = (checksum + (kept[index].index ^ round)) | 0;',
      '  return kept.length + (checksum & 0);',
      '}',
      `it('runs in a forks worker', () => { expect(${MARKER_FUNCTION}()).toBeGreaterThan(0); });`,
      // An exit slower than vitest's 500 ms SIGKILL delay, without CPU use.
      "process.on('exit', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); });",
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root });

    const result = await runProfiler(
      ['run', '--root', root, '--server-unit', 'skip', '--cpu-prof', '--heap-prof', '--label', 'forks', '--out', 'runs'],
      root, 5,
    );
    const outcome = `signal: ${String(result.signal)} (SIGXCPU: a process used 5 s of CPU)\n${result.stdout}${result.stderr}\n${freeSpace(root)}`;
    expect(result.signal, outcome).toBeNull();
    expect(result.status, outcome).toBe(0);

    const runDir = join(root, 'runs', readdirSync(join(root, 'runs'))[0]);
    const step = readdirSync(runDir).find((name) => /^\d{2}-test-unit$/.test(name));
    expect(step, readdirSync(runDir).join(', ')).toBeDefined();
    const stepDir = join(runDir, step!);
    const report = JSON.parse(readFileSync(join(stepDir, 'report.json'), 'utf8'));
    expect(report.profile_write_errors ?? [], `profile writes failed; ${freeSpace(root)}`).toEqual([]);
    for (const [kind, suffix] of [['cpu', '.cpuprofile'], ['heap', '.heapprofile']]) {
      const dir = join(stepDir, kind);
      expect(
        profilesNamingMarker(dir, suffix),
        `${kind} profile of the worker; ${kind}/ holds: ${listing(dir)}; ${freeSpace(root)}`,
      ).toHaveLength(1);
    }
  });
});
