import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import type { TestProjectInlineConfiguration } from 'vitest/config';
import { serverProjects, serverTestBase, workerImportOptions } from './server/vitest.projects.ts';

// The one entry point for the checks the pre-commit hook runs. Its projects
// are named for the hook, and `vitest run --project 'precommit:*'` is the
// hook's whole check list (package.json `precommit`). The root suite alone is
// `vitest run --project precommit:root`.
//
// vitest runs one sequence.groupOrder after another, and the projects of a
// group share one pool, so every project of a group has the same maxWorkers.
// The groups are the hook's phases:
//   0  light checks: the root suite, the hook's node:test files, typecheck
//      and the other command checks (vitest's default, CPUs - 1 workers);
//   1  the server unit suite (CPUs - 2, capped by memory; as
//      scripts/precommit-server-unit.cjs sized it).
// A failure in a group skips the groups after it
// (scripts/vitest-hook-reporter.mjs); a group itself runs to the end.
//
// The server and checks projects exist only when a --project argument names
// them, so other runs of this config (the root suite, the node-tests scripts,
// `vitest list`, editors) never read the git index or scan the server tree.
//
// vitest loads this file once. It loads it again for every inline project
// that gets a Vite server of its own, which a project does when it sets
// `test.root` (or another option that changes the Vite config) and inherits
// this config: nine loads, nine server-tree scans and nine `git diff
// --cached` calls per hook run. So the root is set once, at the top level,
// and the light projects share this config's Vite server; the server
// projects, whose root is server/, take nothing from this file
// (`extends: false`), so their servers are built without loading it.

const require = createRequire(import.meta.url);
// Workers share the @adcp/sdk validator cache with the storyboard matrix,
// except in CI (scripts/sdk-validator-cache.cjs).
const { validatorCacheEnv } = require('./scripts/sdk-validator-cache.cjs') as {
  validatorCacheEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string>;
};
const { resolveWorkerCount, serverUnitFilter } = require('./scripts/precommit-server-unit.cjs') as {
  resolveWorkerCount(env?: NodeJS.ProcessEnv): number;
  serverUnitFilter(env?: NodeJS.ProcessEnv): (file: string) => boolean;
};
const { NODE_TEST_FILES } = require('./scripts/vitest-node-test-files.cjs') as { NODE_TEST_FILES: string[] };

const ROOT = import.meta.dirname;
const SERVER_PREFIX = 'precommit:server-';
// server/vitest.config.ts's unit-shared, unit-first, unit-fresh and
// unit-isolated, as named here.
const SERVER_PROJECT_NAMES = ['shared', 'first', 'fresh', 'isolated'].map((name) => `${SERVER_PREFIX}${name}`);

/** The --project patterns on the command line (vitest matches `*` as any run of characters). */
function projectPatterns(argv = process.argv): RegExp[] {
  const patterns: string[] = [];
  argv.forEach((arg, i) => {
    if (arg === '--project' && argv[i + 1] !== undefined) patterns.push(argv[i + 1]);
    else if (arg.startsWith('--project=')) patterns.push(arg.slice('--project='.length));
  });
  return patterns.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
}
const patterns = projectPatterns();
const requested = (name: string) => patterns.some((pattern) => pattern.test(name));

// The root suite's options (the whole root config before tp-jyw.51).
const ROOT_SUITE = {
  // Forks, not threads: with threads every worker's heap lives in the one
  // vitest process (5+ GB), and each child process a test spawns forks that
  // whole address space (57-70 ms of kernel time per spawn on Linux, against
  // 1.6 ms from a forks worker). A fork worker whose vitest main process dies
  // waits on it forever, so the launchers stop each command's whole process
  // group: the pre-commit runner (scripts/profile-precommit/runner.mjs) and
  // scripts/with-timeout.sh.
  pool: 'forks' as const,
  // Cap individual test hangs at 10 s so a single stalled test doesn't
  // silently consume the entire 60 s precommit budget with no test name.
  testTimeout: 10000,
  // Builds dist/schemas/latest once, before any worker starts, for runs
  // that include a file that reads it (BUILT_SCHEMA_FILES there).
  globalSetup: ['./tests/setup/built-schemas.ts'],
  env: validatorCacheEnv(process.env, ROOT),
  // The profilers' worker module (ADCP_VITEST_WORKER_IMPORT), in every project.
  ...workerImportOptions(),
};
// node:test files; the hook's own run in precommit:node-tests.
const ROOT_SUITE_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.addie-repos/**', '**/*.test.cjs'];

const projects: TestProjectInlineConfiguration[] = [
  {
    // The root suite: every vitest file under tests/ except the hook's
    // checks, which have their own project (exclude globs are relative to dir).
    test: { ...ROOT_SUITE, name: 'precommit:root', dir: 'tests', exclude: [...ROOT_SUITE_EXCLUDE, 'hook-checks/**'] },
  },
  {
    // Every other test file this config reaches, with the same options: the
    // npm scripts that run server test files by path through the root config
    // (test:certification-demo-formatting, test:registry, test:simulation).
    test: { ...ROOT_SUITE, name: 'repo', exclude: [...ROOT_SUITE_EXCLUDE, 'tests/**'] },
  },
  {
    // The node:test files the hook runs, under vitest (tp-jyw.51). A process
    // of its own per file and node --test's limit, as node --test ran them.
    test: {
      name: 'precommit:node-tests',
      include: NODE_TEST_FILES.length ? NODE_TEST_FILES : ['__no_files__'],
      // CommonJS cannot require vitest; the files use its globals.
      globals: true,
      pool: 'forks',
      isolate: true,
      // node --test ran them with --test-timeout=30000.
      testTimeout: 30_000,
      // node --import tsx: two of them require server TypeScript modules.
      setupFiles: ['./tests/setup/tsx-require.cjs'],
      env: validatorCacheEnv(process.env, ROOT),
      ...workerImportOptions(),
    },
  },
];

if (requested('precommit:checks')) {
  projects.push({
    // The hook's checks that are commands rather than test files: typecheck,
    // the governance JWS vector check, the advisory image check.
    test: {
      name: 'precommit:checks',
      include: ['tests/hook-checks/*.test.ts'],
      pool: 'forks',
      // Unbounded, as the hook ran these commands: tsc never had a limit.
      testTimeout: 0,
      ...workerImportOptions(),
    },
  });
}

if (SERVER_PROJECT_NAMES.some(requested)) {
  // The server unit suite, as `npm run test:server-unit` runs it, limited to
  // the staged-file plan (ADCP_PRECOMMIT_SERVER_UNIT_PLAN=full|skip|auto).
  const unitFilter = serverUnitFilter();
  // ADCP_PRECOMMIT_SERVER_UNIT_WORKERS=N, or CPUs - 2 capped by memory.
  const workers = resolveWorkerCount();
  for (const project of serverProjects({ prefix: SERVER_PREFIX, unitFilter, serial: false })) {
    const base = serverTestBase();
    projects.push({
      extends: false,
      test: {
        ...base,
        ...project,
        // server/vitest.config.ts's projects extend its root options, which
        // concatenates setup files; here they are listed whole.
        setupFiles: [...base.setupFiles, ...(project.setupFiles ?? [])],
        maxWorkers: workers,
        // Every server unit project is in group 1, after the light checks.
        sequence: { groupOrder: 1 },
      },
    });
  }
}

export default defineConfig({
  // The light projects' root; they inherit it from here.
  root: ROOT,
  test: {
    reporters: ['default', './scripts/vitest-hook-reporter.mjs'],
    projects,
  },
});
