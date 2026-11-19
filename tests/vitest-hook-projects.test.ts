// The pre-commit hook's checks run as one vitest invocation over the root
// config's projects (tp-jyw.51): `vitest run --project 'precommit:*'`.
// Driven through the public surfaces only:
//   - `node scripts/profile-precommit.mjs plan` (what the hook runs);
//   - `vitest list --filesOnly --project ... --json=<file>` (which files each
//     precommit: project runs);
//   - `vitest run` over a throwaway config that uses
//     scripts/vitest-hook-reporter.mjs (fail-fast between groups).
// The "before" file sets are computed from the tree at run time with the
// rules the old hook steps used (root suite: vitest's default include under
// tests/ minus *.test.cjs; server step: server/vitest.config.ts over
// tests/unit/ and src/), so a test file added later is covered without
// editing this file. The 22 node:test files the hook ran are pinned below.
// Nothing asserts on wall-clock time; every child is SIGKILLed by a guard
// well inside the root project's 10 s test timeout (vitest.config.ts), so a
// hang fails with its own message.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

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

/** `vitest list --filesOnly <args> --json=<file>` from the repo root, grouped by project. */
async function vitestList(args: string[], env: Record<string, string> = {}): Promise<Listing> {
  const out = join(scratchDir('vitest-hook-projects-list-'), 'list.json');
  const result = await runNode([VITEST_BIN, 'list', '--filesOnly', ...args, `--json=${out}`], { env: childEnv(env) });
  // The checkout path may itself contain "git" (~/git/adcp); keep it out of
  // the git-warning checks.
  const output = `${result.stdout}\n${result.stderr}`.split(REPO_ROOT).join('<repo>');
  expect(result.code, `vitest list ${args.join(' ')} exits 0\n${output}`).toBe(0);
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as Array<{ file: string; projectName?: string }>;
  const entries = parsed.map((entry) => ({ project: entry.projectName ?? '', file: toRepoPath(entry.file) }));
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

describe('vitest list --project precommit:root (the root suite; no hook side effects)', () => {
  it('lists only precommit:root, even with the full server plan', async () => {
    const listing = await vitestList(['--project', 'precommit:root'], { ADCP_PRECOMMIT_SERVER_UNIT_PLAN: 'full' });

    expect([...listing.byProject.keys()], 'no server-* or checks project is built').toEqual(['precommit:root']);
    expect(filesOf(listing, 'precommit:root')).toEqual(oldRootSuiteFiles());
  });

  it('does not run the staged-file plan: a broken git is never called', async () => {
    const listing = await vitestList(['--project', 'precommit:root'], {
      GIT_DIR: brokenGitDir(),
    });

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

function runGroups(fixture: GroupsFixture, aFails: boolean): Promise<RunResult> {
  return runNode([VITEST_BIN, 'run', '--config', join(fixture.root, 'vitest.config.mjs')], {
    cwd: fixture.root,
    env: childEnv({ FIXTURE_A_FAILS: aFails ? '1' : '0' }),
  });
}

describe('fail-fast between groups (scripts/vitest-hook-reporter.mjs)', () => {
  it('a failed earlier group stops the later group before its test bodies run; every failure in the group is reported', async () => {
    expect(existsSync(REPORTER), `${toRepoPath(REPORTER)} exists`).toBe(true);
    const fixture = groupsFixture();

    const result = await runGroups(fixture, true);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code, `vitest run fails\n${output}`).not.toBe(0);
    expect(output, 'group 0 collects all: a1 failure reported').toContain('a1 failed on purpose');
    expect(output, 'group 0 collects all: a2 failure reported').toContain('a2 failed on purpose');
    expect(existsSync(fixture.marker), `group 1 test body never runs\n${output}`).toBe(false);
  });

  it('ADCP_PRECOMMIT_KEEP_GOING=1 runs the later group after a failure', async () => {
    const fixture = groupsFixture();

    const result = await runNode([VITEST_BIN, 'run', '--config', join(fixture.root, 'vitest.config.mjs')], {
      cwd: fixture.root,
      env: childEnv({ FIXTURE_A_FAILS: '1', ADCP_PRECOMMIT_KEEP_GOING: '1' }),
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code, `vitest run fails\n${output}`).not.toBe(0);
    expect(existsSync(fixture.marker), `group 1 test body ran\n${output}`).toBe(true);
  });

  it('a passing earlier group lets the later group run', async () => {
    expect(existsSync(REPORTER), `${toRepoPath(REPORTER)} exists`).toBe(true);
    const fixture = groupsFixture();

    const result = await runGroups(fixture, false);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code, `vitest run passes\n${output}`).toBe(0);
    expect(existsSync(fixture.marker), `group 1 test body ran\n${output}`).toBe(true);
  });
});

// ------------------------------------------------------- advisory checks

describe('advisory checks (tests/hook-checks/command.ts runAdvisoryCheck)', () => {
  it('a failing advisory command prints its output and a warning, and its test passes', async () => {
    const root = scratchDir('vitest-hook-advisory-');
    const command = join(REPO_ROOT, 'tests', 'hook-checks', 'command.ts');
    writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { root: import.meta.dirname, include: [\'*.test.ts\'] } };\n');
    writeFileSync(join(root, 'advisory.test.ts'), `
import { test } from 'vitest';
import { runAdvisoryCheck } from ${JSON.stringify(command)};
test('fixture advisory check', async ({ annotate }) => {
  await runAdvisoryCheck('echo "images/huge.png exceeds 700KB" >&2; exit 3', annotate);
});
`);

    const result = await runNode([VITEST_BIN, 'run', '--config', join(root, 'vitest.config.mjs')], { cwd: root });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code, `an advisory failure does not fail the run\n${output}`).toBe(0);
    expect(output).toContain('images/huge.png exceeds 700KB');
    expect(output).toMatch(/advisory: .* exited 3; it does not block the commit/);
  });
});
