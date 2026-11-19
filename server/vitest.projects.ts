// The server suite's vitest projects, in one place for both configs that run
// them: server/vitest.config.ts (`npm run test:server-unit`, CI's shards) and
// the root vitest.config.ts, whose `precommit:server-unit-*` projects are the
// pre-commit hook's server step.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { configDefaults } from 'vitest/config';

export const SERVER_ROOT = import.meta.dirname;
const REPO_ROOT = path.dirname(SERVER_ROOT);
const require = createRequire(import.meta.url);

// Reused workers hold more memory than fresh ones; the default worker count
// is capped by memory as well as CPUs (scripts/server-unit-workers.cjs).
// --maxWorkers on the command line still wins.
export const { resolveWorkerCount } = require('../scripts/server-unit-workers.cjs') as {
  resolveWorkerCount(options?: { reservedCpus?: number }): number;
};
// Workers share the @adcp/sdk validator cache with the storyboard matrix,
// except in CI (scripts/sdk-validator-cache.cjs).
const { validatorCacheEnv } = require('../scripts/sdk-validator-cache.cjs') as {
  validatorCacheEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string>;
};
// Workers share Node's compile cache with the pre-push hook
// (scripts/node-compile-cache.cjs).
const { compileCacheEnv } = require('../scripts/node-compile-cache.cjs') as {
  compileCacheEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string>;
};

// Unit test files that cannot share a worker yet. Both lists may only
// shrink: every entry names its record in scripts/vitest-leak-inventory.json
// and its class (unknown cause / known, not yet fixed / needs a fresh
// process). Fix the file, then remove the entry in the same commit.
//
// A fresh process per file, alongside the shared projects. A file that leaks
// state goes here (the polluter, not only its victims).
export const ISOLATED_UNIT_FILES: Record<string, string> = {
  'tests/unit/native-auth-http-wiring.test.ts':
    'VL-10-002, unknown cause: its vi.mock of @workos-inc/node survives the next file\'s module reset',
};
// A fresh process per file, one at a time after the shared projects, for
// files that fail under CPU load.
export const ALONE_UNIT_FILES: Record<string, string> = {
  'tests/unit/addie/matched-pair-ni/exact-inference.test.ts':
    'VL-07-001, known, not yet fixed: its child-process checks race under CPU load (failed 2 of 5 runs at 12 workers)',
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Files that mock modules, or prepare state before their imports
// (`vi.hoisted`, e.g. env that a module reads at import), run in the
// `unit-fresh` project: each of them starts from a fresh module graph
// (tests/setup/fresh-module-graph.ts).
const NEEDS_FRESH_MODULES = /\bvi\.(?:mock|doMock|hoisted)\(/;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(SERVER_ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(file, out);
    else if (TEST_FILE.test(entry.name)) out.push(file);
  }
  return out;
}

// An empty include falls back to vitest's default pattern; match nothing.
const only = (files: string[]) => (files.length ? files : ['__no_files__']);

/**
 * The options every server project has: in server/vitest.config.ts its root
 * `test` options (the projects extend them), in the root config each
 * project's own.
 */
export function serverTestBase() {
  return {
    globals: true,
    environment: 'node',
    root: SERVER_ROOT,
    setupFiles: ['./tests/setup/revenue-tracking-env.ts', './tests/setup/conductor-loopback-setup.ts'],
    // Build the schema tree, then do the cold work every worker's first
    // training-agent setup would repeat (tests/setup/warm-caches.ts).
    globalSetup: ['./tests/setup/built-schemas.ts', './tests/setup/warm-caches.ts'],
    env: { ...validatorCacheEnv(process.env, REPO_ROOT), ...compileCacheEnv(process.env, REPO_ROOT) },
    testTimeout: 30000,
    pool: 'forks' as const,
    // Undo vi.stubEnv / vi.stubGlobal before every test (the setup file also
    // undoes them before each file's imports).
    unstubEnvs: true,
    unstubGlobals: true,
  };
}

/** A server project's own options, beside serverTestBase(). */
export interface ServerProjectOptions {
  include: string[];
  exclude?: string[];
  isolate: boolean;
  setupFiles?: string[];
  fileParallelism?: boolean;
  sequence?: { groupOrder: number };
}

interface ServerProjectsOptions {
  /**
   * Names for the projects in another config: `unit-shared` becomes
   * `${prefix}shared` (the root config's `precommit:server-shared`).
   */
  prefix?: string;
  /** Unit files (server-relative) to keep; default all. */
  unitFilter?: (file: string) => boolean;
  /** Include the `serial` project (integration and other suites). */
  serial?: boolean;
}

/**
 * The server projects' own options (without serverTestBase()). Project
 * `test.sequence.groupOrder` is 0 for the shared projects and 1 for the
 * ones that run after them.
 */
export function serverProjects({ prefix = '', unitFilter = () => true, serial = true }: ServerProjectsOptions = {}) {
  const unitFiles = [...testFiles('tests/unit'), ...testFiles('src')]
    .filter((file) => !(file in ISOLATED_UNIT_FILES) && !(file in ALONE_UNIT_FILES));
  const freshFiles = new Set(unitFiles.filter((file) => NEEDS_FRESH_MODULES.test(readFileSync(path.join(SERVER_ROOT, file), 'utf8'))));
  const keep = (files: string[]) => only(files.filter(unitFilter));
  const projects: { name: string; test: ServerProjectOptions }[] = [
    {
      // Workers are reused across files (`isolate: false`): modules, and
      // the caches they hold, load once per worker instead of once per
      // file. Files must leave env, globals, timers and module state as
      // they found them.
      name: 'unit-shared',
      test: { include: keep(unitFiles.filter((file) => !freshFiles.has(file))), isolate: false },
    },
    {
      // Reused workers too, but every file starts from a fresh module graph,
      // so its mocks and pre-import state reach every module it imports and
      // no later file inherits them. A worker only runs files of its own
      // project, so these resets never reach the `unit-shared` workers.
      // vitest queues projects by name: this one, which holds the longest
      // files, starts first.
      name: 'unit-fresh',
      test: { include: keep([...freshFiles]), isolate: false, setupFiles: ['./tests/setup/fresh-module-graph.ts'] },
    },
    {
      name: 'unit-isolated',
      test: { include: keep(Object.keys(ISOLATED_UNIT_FILES)), isolate: true },
    },
    {
      // After the shared projects, so a load-sensitive file sees an idle
      // machine. Shares groupOrder 1 with `serial`; the two never have
      // files in the same run.
      name: 'unit-alone',
      test: {
        include: keep(Object.keys(ALONE_UNIT_FILES)),
        isolate: true,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    },
  ];
  if (serial) {
    projects.push({
      // Integration and other suites share one database and keep a fresh
      // process per file, one file at a time.
      name: 'serial',
      test: {
        include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
        exclude: [...configDefaults.exclude, 'tests/unit/**'],
        isolate: true,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    });
  }
  return projects.map(({ name, test }) => ({ ...test, name: prefix ? `${prefix}${name.replace(/^unit-/, '')}` : name }));
}

