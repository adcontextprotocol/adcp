// The pre-commit hook's checks run as one vitest invocation over the root
// config's projects (tp-jyw.51): `vitest run --project 'precommit:*'`.
// Driven through the public surfaces only:
//   - `node scripts/profile-precommit.mjs plan` (what the hook runs);
//   - vitest's Node API, as `vitest list --filesOnly --project ...` drives it
//     (createVitest + getRelevantTestSpecifications: which files each
//     precommit: project runs);
//   - vitest's startVitest, as `vitest run` drives it, over a throwaway config
//     that uses scripts/vitest-hook-reporter.mjs (fail-fast between groups).
// The vitest runs are in this worker, under the environment and argv the CLI
// process would have had (tests/helpers/vitest-config-env.ts): the config
// reads both when vitest loads it, and a whole vitest process per case cost
// a second of CPU or more. The work guard: no listing or fixture run starts
// a process other than the config's own git call.
// The "before" file sets are computed from the tree at run time with the
// rules the old hook steps used (root suite: vitest's default include under
// tests/ minus *.test.cjs; server step: server/vitest.config.ts over
// tests/unit/ and src/), so a test file added later is covered without
// editing this file. The 22 node:test files the hook ran are pinned below.
// Nothing asserts on wall-clock time; every plan child is SIGKILLed by a
// guard well inside the root project's 10 s test timeout (vitest.config.ts),
// so a hang fails with its own message.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createVitest, startVitest } from 'vitest/node';
import { runAdvisoryCheck } from './hook-checks/command.ts';
import { withProcessState } from './helpers/vitest-config-env.ts';

// Before any import, so a launcher a module destructures is counted too.
const spawns = await vi.hoisted(async () => {
  const { createRequire: requireFrom } = await import('node:module');
  return requireFrom(import.meta.url)('./helpers/spawn-counter.cjs').install() as { count: number; commands: string[] };
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const PROFILER = join(REPO_ROOT, 'scripts', 'profile-precommit.mjs');
const REPORTER = join(REPO_ROOT, 'scripts', 'vitest-hook-reporter.mjs');
const NODE_TEST_FILES_MODULE = join(REPO_ROOT, 'scripts', 'vitest-node-test-files.cjs');
const GUARD_MS = 8_000;

// The node:test files the B17 pre-commit plan ran (10 node --test commands):
// canonical vectors (2), JWS vectors (1), storyboard compliance under
// --import tsx (11), lint tests (8).
const HOOK_NODE_TEST_FILES = [
  'tests/canonical-image-pixel-ratio-vectors.test.cjs',
  'tests/canonical-display-acceptance-vectors.test.cjs',
  'tests/governance-authorization-jws-vectors.test.cjs',
  'tests/auction-only-seller-compliance.test.cjs',
  'tests/creative-format-gate-compliance.test.cjs',
  'tests/currency-filter-compliance.test.cjs',
  'tests/optional-seller-capabilities.test.cjs',
  'tests/product-filter-auction-compliance.test.cjs',
  'tests/canonical-compatibility-slices.test.cjs',
  'tests/governance-recovery-pricing-scope.test.cjs',
  'tests/literal-auction-bid-compliance.test.cjs',
  'tests/optional-discovery-contract.test.cjs',
  'tests/storyboard-exclusion-compat.test.cjs',
  'tests/operator-fee-seller-exclusion.test.cjs',
  'tests/lint-test-dynamic-imports.test.cjs',
  'tests/lint-test-spawn-tooling.test.cjs',
  'tests/lint-test-builds.test.cjs',
  'tests/lint-test-git-env.test.cjs',
  'tests/lint-format-identity-boundaries.test.cjs',
  'tests/lint-narrow-imports.test.cjs',
  'tests/lint-module-eval-cycles.test.cjs',
  'tests/lint-callapi-state-change.test.cjs',
].sort();

// server/vitest.config.ts's unit-<name> projects, all in the server group
// (group 1). unit-first holds the file that must start first in that group.
const SERVER_PROJECTS = ['shared', 'fresh', 'isolated', 'first'] as const;
// vitest's BaseSequencer orders files by groupOrder, then by project name, so
// the project whose name sorts first in a group has its files queued first.
const FIRST_SERVER_FILES = ['server/tests/unit/addie/matched-pair-ni/exact-inference.test.ts'];
const PRECOMMIT_PROJECTS = new Set([
  'precommit:root', 'precommit:node-tests', 'precommit:checks',
  ...SERVER_PROJECTS.map((name) => `precommit:server-${name}`),
]);

// ------------------------------------------------------------------ harness

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Environment for child processes: none of this run's vitest, hook or npm state. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|ADCP_PRECOMMIT_|ADCP_TIMEOUT_SCALE$|NODE_OPTIONS$|VITEST|TINYPOOL|HUSKY|GIT_)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', ...extra };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs node with args; SIGKILLs it if it outlives GUARD_MS (inside the test timeout). */
function runNode(args: string[], { cwd = REPO_ROOT, env = childEnv() } = {}): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(NODE, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const guard = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, GUARD_MS);
    child.on('error', (error) => { clearTimeout(guard); rejectRun(error); });
    child.on('close', (code) => {
      clearTimeout(guard);
      if (killed) rejectRun(new Error(`node ${args.join(' ')} still running after ${GUARD_MS} ms\n${stdout}\n${stderr}`));
      else resolveRun({ code, stdout, stderr });
    });
  });
}

const toRepoPath = (file: string) => relative(REPO_ROOT, resolve(REPO_ROOT, file)).split(sep).join('/');

interface Listing {
  /** project name -> sorted repo-relative files */
  byProject: Map<string, string[]>;
  /** every (project, file) pair, for duplicate checks */
  entries: Array<{ project: string; file: string }>;
  output: string;
}

/** A stream that keeps what is written to it. */
function collector(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/**
 * Runs fn as the vitest CLI process `vitest <argv>` from cwd with env would
 * run it: that environment and argv, vitest's logger and every console call
 * collected as its output. Asserts that fn starts no process except at
 * most `gitCalls` git calls: the staged-file plan's `git diff --cached`,
 * once per load of vitest.config.ts, which vitest loads once per run.
 */
async function asVitestProcess<T>(
  argv: string[],
  { cwd = REPO_ROOT, env = childEnv(), gitCalls = 0 },
  fn: (streams: { stdout: Writable; stderr: Writable }) => Promise<T>,
): Promise<{ value: T; output: string; exitCode: number }> {
  const stdout = collector();
  const stderr = collector();
  const before = spawns.count;
  const consoleLines: string[] = [];
  const outcome = await withProcessState({ env, cwd, argv: [NODE, VITEST_BIN, ...argv] }, async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); }));
    try {
      const value = await fn({ stdout, stderr });
      return { value, exitCode: Number(process.exitCode ?? 0) };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  const started = spawns.commands.slice(before);
  expect(started.filter((command) => command !== 'git'), `vitest ${argv.join(' ')} in this worker starts no process`).toEqual([]);
  expect(started.length, `vitest ${argv.join(' ')} loads vitest.config.ts once: at most ${gitCalls} git call(s)`).toBeLessThanOrEqual(gitCalls);
  // The checkout path may itself contain "git" (~/git/adcp); keep it out of
  // the git-warning checks.
  const output = [stdout.text(), stderr.text(), ...consoleLines].join('\n').split(REPO_ROOT).join('<repo>');
  return { ...outcome, output };
}

/** `vitest list --filesOnly <args>` from the repo root, grouped by project. */
async function vitestList(args: string[], env: Record<string, string> = {}, { gitCalls = 1 } = {}): Promise<Listing> {
  const configIndex = args.indexOf('--config');
  const config = configIndex >= 0 ? join(REPO_ROOT, args[configIndex + 1]) : undefined;
  const projects = args.flatMap((arg, i) => (args[i - 1] === '--project' ? [arg] : []));
  const filters = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--project' && args[i - 1] !== '--config');
  const { value: specs, output } = await asVitestProcess(['list', '--filesOnly', ...args], { env: childEnv(env), gitCalls }, async ({ stdout, stderr }) => {
    const ctx = await createVitest('test', { config, ...(projects.length ? { project: projects } : {}), watch: false, run: true }, {}, { stdout, stderr });
    try {
      return await ctx.getRelevantTestSpecifications(filters);
    } finally {
      await ctx.close();
    }
  });
  const entries = specs.map((spec) => ({ project: spec.project.name, file: toRepoPath(spec.moduleId) }));
  const byProject = new Map<string, string[]>();
  for (const { project, file } of entries) byProject.set(project, [...(byProject.get(project) ?? []), file]);
  for (const files of byProject.values()) files.sort();
  return { byProject, entries, output };
}

/** A GIT_DIR that does not exist, so any git call fails (its path names no "git"). */
const brokenGitDir = () => join(scratchDir('vitest-hook-projects-vcs-'), 'missing');

const filesOf = (listing: Listing, project: string) => listing.byProject.get(project) ?? [];

// ------------------------------------------------------- "before" file sets

const VITEST_DEFAULT_INCLUDE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Repo-relative test files under dir (vitest's default include), skipping skipDirs. */
function walkTests(dir: string, skipDirs: Set<string>, out: string[] = []): string[] {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkTests(file, skipDirs, out);
    else if (VITEST_DEFAULT_INCLUDE.test(entry.name)) out.push(file);
  }
  return out;
}

/**
 * Files `vitest run --dir tests/` ran before (root vitest.config.ts: default
 * include, excluding node_modules, dist, .addie-repos and *.test.cjs), minus
 * the hook-check files that moved to precommit:checks.
 */
function oldRootSuiteFiles(): string[] {
  return walkTests('tests', new Set(['node_modules', 'dist', '.addie-repos']))
    .filter((file) => !file.endsWith('.test.cjs'))
    .filter((file) => !file.startsWith('tests/hook-checks/'))
    .sort();
}

/** Files the old server step ran (server/vitest.config.ts over tests/unit/ and src/). */
function oldServerStepFiles(): string[] {
  const skip = new Set(['node_modules']);
  return [...walkTests('server/tests/unit', skip), ...walkTests('server/src', skip)].sort();
}

function hookCheckFiles(): string[] {
  const dir = join(REPO_ROOT, 'tests', 'hook-checks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.test.ts')).map((name) => `tests/hook-checks/${name}`).sort();
}

function nodeTestFilesExport(): string[] {
  expect(existsSync(NODE_TEST_FILES_MODULE), `${toRepoPath(NODE_TEST_FILES_MODULE)} exists`).toBe(true);
  const mod = createRequire(import.meta.url)(NODE_TEST_FILES_MODULE) as { NODE_TEST_FILES?: string[] };
  expect(Array.isArray(mod.NODE_TEST_FILES), 'NODE_TEST_FILES is exported as an array').toBe(true);
  return mod.NODE_TEST_FILES!.map(toRepoPath).sort();
}

function expectNoFileInTwoProjects(listing: Listing): void {
  const seen = new Map<string, string>();
  const twice: string[] = [];
  for (const { project, file } of listing.entries) {
    const first = seen.get(file);
    if (first !== undefined) twice.push(`${file}: ${first} and ${project}`);
    else seen.set(file, project);
  }
  expect(twice, 'each file runs in exactly one precommit: project').toEqual([]);
}

/** (a)-(c): precommit:root, precommit:node-tests and precommit:checks. */
function expectLightProjects(listing: Listing): void {
  expect(filesOf(listing, 'precommit:root'), 'precommit:root = the old root suite minus tests/hook-checks/**')
    .toEqual(oldRootSuiteFiles());

  const nodeTests = nodeTestFilesExport();
  expect(nodeTests, 'NODE_TEST_FILES = the 22 node:test files the hook ran').toEqual(HOOK_NODE_TEST_FILES);
  expect(filesOf(listing, 'precommit:node-tests'), 'precommit:node-tests = the hook\'s 22 node:test files')
    .toEqual(HOOK_NODE_TEST_FILES);

  const checks = hookCheckFiles();
  expect(checks.some((file) => /typecheck/.test(file)), `a typecheck check under tests/hook-checks/ (${checks})`).toBe(true);
  expect(checks.some((file) => /jws/i.test(file)), `a JWS vectors check under tests/hook-checks/ (${checks})`).toBe(true);
  expect(checks.some((file) => /image/.test(file)), `an image-quality check under tests/hook-checks/ (${checks})`).toBe(true);
  expect(filesOf(listing, 'precommit:checks'), 'precommit:checks = tests/hook-checks/*.test.ts').toEqual(checks);
}

// -------------------------------------------------------------------- tests

interface PlanLeaf { command: string; kind: string; advisory: boolean }

/**
 * The guard: what in a hook plan is not the one vitest entry point. A check
 * the hook runs belongs in a precommit: project of vitest.config.ts, not in a
 * runner command of its own (node --test, a script, a second vitest config).
 */
function planViolations(plan: PlanLeaf[]): string[] {
  const violations = plan
    .filter((leaf) => leaf.command.replace(/['"]/g, '') !== 'vitest run --project precommit:*')
    .map((leaf) => `${leaf.kind}: ${leaf.command}`);
  if (plan.length !== 1) violations.push(`${plan.length} leaves, expected exactly one`);
  return violations;
}

async function planOf(root = REPO_ROOT): Promise<PlanLeaf[]> {
  const result = await runNode([PROFILER, 'plan', '--root', root]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as PlanLeaf[];
}

/** A throwaway root whose package.json has the given precommit script. */
function planRoot(precommit: string): string {
  const root = scratchDir('vitest-hook-plan-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'plan-fixture', version: '0.0.0', private: true, scripts: {
    precommit, 'test:lint': 'node --test tests/lint.test.cjs',
  } }));
  return root;
}

describe('pre-commit plan (node scripts/profile-precommit.mjs plan)', () => {
  it('is one vitest leaf, vitest run --project \'precommit:*\', with no budget', async () => {
    const plan = await planOf();
    expect(plan.map((leaf) => leaf.command), 'the plan has exactly one leaf').toHaveLength(1);
    const [leaf] = plan;
    expect(leaf.command.replace(/['"]/g, ''), 'the leaf selects every precommit: project').toBe('vitest run --project precommit:*');
    expect(leaf.kind).toBe('vitest');
    expect(leaf.advisory).toBe(false);
    expect(planViolations(plan)).toEqual([]);
  });

  it('the guard flags a check added beside the vitest entry point, directly or through an npm script', async () => {
    expect(planViolations(await planOf(planRoot("vitest run --project 'precommit:*' && npm run test:lint")))).toEqual([
      'node-test: node --test tests/lint.test.cjs',
      '2 leaves, expected exactly one',
    ]);
    expect(planViolations(await planOf(planRoot('vitest run --config server/vitest.config.ts')))).toEqual([
      'vitest: vitest run --config server/vitest.config.ts',
    ]);
    // Would-be-missed by a "starts with vitest run" check: a vitest leaf that
    // selects only some of the hook's projects.
    expect(planViolations(await planOf(planRoot('vitest run --project precommit:root')))).toEqual([
      'vitest: vitest run --project precommit:root',
    ]);
  });
});

describe("vitest list --project 'precommit:*' (the hook's file selection)", () => {
  it('full server plan: each project lists exactly the files its old hook step ran, each file once', async () => {
    const [listing, serverConfig] = await Promise.all([
      vitestList(['--project', 'precommit:*'], { ADCP_PRECOMMIT_SERVER_UNIT_PLAN: 'full' }),
      // The old server step, as CI still runs it (npm run test:server-unit).
      vitestList(['--config', 'server/vitest.config.ts', 'tests/unit/', 'src/']),
    ]);

    const projects = [...listing.byProject.keys()];
    expect(projects.filter((name) => !PRECOMMIT_PROJECTS.has(name)), 'only the precommit: projects are listed').toEqual([]);
    expectNoFileInTwoProjects(listing);
    expectLightProjects(listing);

    // (d) the server projects together run exactly the old server step's files...
    const serverFiles = SERVER_PROJECTS.flatMap((name) => filesOf(listing, `precommit:server-${name}`)).sort();
    expect(serverFiles, 'precommit:server-* = the files of server/vitest.config.ts tests/unit/ src/').toEqual(oldServerStepFiles());
    // ...split as server/vitest.config.ts splits them (unit-<name> -> precommit:server-<name>).
    expect([...serverConfig.byProject.keys()].sort(), 'server/vitest.config.ts keeps its unit project names')
      .toEqual(SERVER_PROJECTS.map((name) => `unit-${name}`).sort());
    for (const name of SERVER_PROJECTS) {
      expect(filesOf(listing, `precommit:server-${name}`), `precommit:server-${name} = unit-${name}`)
        .toEqual(filesOf(serverConfig, `unit-${name}`));
    }
    // (e) the first-queued server project holds exactly the files that must
    // start first, and its name sorts first among the group-1 projects listed.
    expect(filesOf(listing, 'precommit:server-first'), 'precommit:server-first = the files queued first in the server group')
      .toEqual(FIRST_SERVER_FILES);
    const serverProjectNames = projects.filter((name) => name.startsWith('precommit:server-')).sort();
    expect(serverProjectNames[0], `precommit:server-first sorts first among ${serverProjectNames.join(', ')}`)
      .toBe('precommit:server-first');
  });

  it('skip server plan: no server project lists a file; root, node-tests and checks are unchanged', async () => {
    const listing = await vitestList(['--project', 'precommit:*'], { ADCP_PRECOMMIT_SERVER_UNIT_PLAN: 'skip' });

    const serverListed = [...listing.byProject.keys()].filter((name) => name.startsWith('precommit:server-'));
    expect(serverListed, 'no precommit:server-* files with the skip plan').toEqual([]);
    expect([...listing.byProject.keys()].sort()).toEqual(['precommit:checks', 'precommit:node-tests', 'precommit:root']);
    expectNoFileInTwoProjects(listing);
    expectLightProjects(listing);
  });

  it('a failing git call in the staged-file plan means the full server plan, with a warning', async () => {
    const listing = await vitestList(['--project', 'precommit:*'], {
      GIT_DIR: brokenGitDir(),
    });

    const serverFiles = SERVER_PROJECTS.flatMap((name) => filesOf(listing, `precommit:server-${name}`)).sort();
    expect(serverFiles, 'git failed: the server projects get the full plan').toEqual(oldServerStepFiles());
    expect(listing.output, 'the git failure is reported as a warning').toMatch(/git/i);
  });
});

describe("worker import (ADCP_VITEST_WORKER_IMPORT, the profilers' worker module)", () => {
  /** Each precommit: project's resolved worker execArgv, as `vitest run --project 'precommit:*'` resolves them. */
  async function workerExecArgv(env: Record<string, string>): Promise<Map<string, string[]>> {
    const { value } = await asVitestProcess(['run', '--project', 'precommit:*'], { env: childEnv({ ADCP_PRECOMMIT_SERVER_UNIT_PLAN: 'full', ...env }), gitCalls: 1 }, async ({ stdout, stderr }) => {
      const ctx = await createVitest('test', { project: ['precommit:*'], watch: false, run: true }, {}, { stdout, stderr });
      try {
        return new Map(ctx.projects.map((project) => [project.name, [...(project.config.execArgv ?? [])]]));
      } finally {
        await ctx.close();
      }
    });
    return value;
  }

  it('reaches every precommit: project, server projects included, and none without it', async () => {
    // vitest applies a command-line --execArgv to the root config only, so
    // a profiler that passed one lost every project's fork workers.
    const url = 'file:///profiler-fixture.mjs?dirs=e30';
    const withImport = await workerExecArgv({ ADCP_VITEST_WORKER_IMPORT: url });
    expect([...withImport.keys()].filter((name) => name.startsWith('precommit:server-')).length).toBeGreaterThan(0);
    for (const [name, execArgv] of withImport) expect(execArgv, name).toContain(`--import=${url}`);
    for (const [name, execArgv] of await workerExecArgv({})) expect(execArgv.some((arg) => arg.includes('profiler-fixture')), name).toBe(false);
  });
});

describe('vitest list --project precommit:root (the root suite; no hook side effects)', () => {
  it('lists only precommit:root, even with the full server plan', async () => {
    const listing = await vitestList(['--project', 'precommit:root'], { ADCP_PRECOMMIT_SERVER_UNIT_PLAN: 'full' });

    expect([...listing.byProject.keys()], 'no server-* or checks project is built').toEqual(['precommit:root']);
    expect(filesOf(listing, 'precommit:root')).toEqual(oldRootSuiteFiles());
  });

  it('does not run the staged-file plan: a broken git is never called', async () => {
    const listing = await vitestList(['--project', 'precommit:root'], {
      GIT_DIR: brokenGitDir(),
    }, { gitCalls: 0 });

    expect([...listing.byProject.keys()]).toEqual(['precommit:root']);
    expect(listing.output, 'no git call, so no git warning').not.toMatch(/git/i);
  });
});

// ------------------------------------------- fail-fast between project groups

interface GroupsFixture {
  root: string;
  marker: string;
}

/**
 * A throwaway vitest config using the hook reporter: project A (groupOrder 0,
 * two files, each with one test that fails when FIXTURE_A_FAILS=1) and
 * project B (groupOrder 1, one file whose test body writes a marker).
 */
function groupsFixture(): GroupsFixture {
  const root = scratchDir('vitest-hook-reporter-');
  const marker = join(root, 'markers', 'b-test-body-ran');
  mkdirSync(join(root, 'markers'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'vitest.config.mjs'), `
const root = import.meta.dirname;
export default {
  test: {
    // Worker threads: the run starts no process (the reporter sees the same
    // groups and modules in any pool).
    pool: 'threads',
    reporters: ['default', ${JSON.stringify(REPORTER)}],
    projects: [
      { test: { name: 'A', root, globals: true, include: ['a/*.test.js'], sequence: { groupOrder: 0 } } },
      { test: { name: 'B', root, globals: true, include: ['b/*.test.js'], sequence: { groupOrder: 1 } } },
    ],
  },
};
`);
  for (const n of [1, 2]) {
    writeFileSync(join(root, 'a', `a${n}.test.js`), `
test('a${n} check', () => {
  if (process.env.FIXTURE_A_FAILS === '1') throw new Error('a${n} failed on purpose');
});
`);
  }
  writeFileSync(join(root, 'b', 'b.test.js'), `
import { writeFileSync } from 'node:fs';
test('b check', () => {
  writeFileSync(${JSON.stringify(marker)}, 'ran');
});
`);
  return { root, marker };
}

/** `vitest run --config <fixture>/vitest.config.mjs` from the fixture root, in this worker. */
async function runGroups(fixture: GroupsFixture, env: Record<string, string>): Promise<{ code: number; output: string }> {
  const config = join(fixture.root, 'vitest.config.mjs');
  const { exitCode, output } = await asVitestProcess(['run', '--config', config], { cwd: fixture.root, env: childEnv(env) }, async ({ stdout, stderr }) => {
    await startVitest('test', [], { config, watch: false, run: true }, {}, { stdout, stderr });
  });
  return { code: exitCode, output };
}

describe('fail-fast between groups (scripts/vitest-hook-reporter.mjs)', () => {
  it('a failed earlier group stops the later group before its test bodies run; every failure in the group is reported', async () => {
    expect(existsSync(REPORTER), `${toRepoPath(REPORTER)} exists`).toBe(true);
    const fixture = groupsFixture();

    const { code, output } = await runGroups(fixture, { FIXTURE_A_FAILS: '1' });

    expect(code, `vitest run fails\n${output}`).not.toBe(0);
    expect(output, 'group 0 collects all: a1 failure reported').toContain('a1 failed on purpose');
    expect(output, 'group 0 collects all: a2 failure reported').toContain('a2 failed on purpose');
    expect(existsSync(fixture.marker), `group 1 test body never runs\n${output}`).toBe(false);
  });

  it('ADCP_PRECOMMIT_KEEP_GOING=1 runs the later group after a failure', async () => {
    const fixture = groupsFixture();

    const { code, output } = await runGroups(fixture, { FIXTURE_A_FAILS: '1', ADCP_PRECOMMIT_KEEP_GOING: '1' });

    expect(code, `vitest run fails\n${output}`).not.toBe(0);
    expect(existsSync(fixture.marker), `group 1 test body ran\n${output}`).toBe(true);
  });

  it('a passing earlier group lets the later group run', async () => {
    expect(existsSync(REPORTER), `${toRepoPath(REPORTER)} exists`).toBe(true);
    const fixture = groupsFixture();

    const { code, output } = await runGroups(fixture, { FIXTURE_A_FAILS: '0' });

    expect(code, `vitest run passes\n${output}`).toBe(0);
    expect(existsSync(fixture.marker), `group 1 test body ran\n${output}`).toBe(true);
  });
});

// ------------------------------------------------------- advisory checks

describe('advisory checks (tests/hook-checks/command.ts runAdvisoryCheck)', () => {
  // In-process, as a hook check's test calls it: a check's test passes unless
  // it throws, and a warning annotation does not fail it. The command is one
  // sh process, as the hook check runs it.
  it('a failing advisory command prints its output and a warning, and its test passes', async () => {
    const annotations: Array<{ message: string; type?: string }> = [];
    const printed: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { printed.push(String(chunk)); return true; });
    let result;
    try {
      result = await runAdvisoryCheck('echo "images/huge.png exceeds 700KB" >&2; exit 3', async (message, type) => {
        annotations.push({ message, type });
      });
    } finally {
      write.mockRestore();
    }
    const output = printed.join('');

    expect(result.status, 'the command failed, and runAdvisoryCheck returned instead of throwing').toBe(3);
    expect(output).toContain('images/huge.png exceeds 700KB');
    expect(output).toMatch(/advisory: .* exited 3; it does not block the commit/);
    expect(annotations.map(({ type }) => type), 'the failure is recorded as a warning annotation').toEqual(['warning']);
  });
});
