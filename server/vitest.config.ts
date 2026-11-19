import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

const ROOT = import.meta.dirname;
// Reused workers hold more memory than fresh ones; the default worker count
// is capped by memory as well as CPUs (scripts/server-unit-workers.cjs).
// --maxWorkers on the command line still wins.
const { resolveWorkerCount } = createRequire(import.meta.url)('../scripts/server-unit-workers.cjs') as {
  resolveWorkerCount(options?: { reservedCpus?: number }): number;
};
// Workers share the @adcp/sdk validator cache with the storyboard matrix,
// except in CI (scripts/sdk-validator-cache.cjs).
const { validatorCacheEnv } = createRequire(import.meta.url)('../scripts/sdk-validator-cache.cjs') as {
  validatorCacheEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string>;
};

// Unit test files that cannot share a worker yet. Both lists may only
// shrink: every entry names its record in scripts/vitest-leak-inventory.json
// and its class (unknown cause / known, not yet fixed / needs a fresh
// process). Fix the file, then remove the entry in the same commit.
//
// A fresh process per file, alongside the shared projects. A file that leaks
// state goes here (the polluter, not only its victims).
const ISOLATED_UNIT_FILES: Record<string, string> = {
  'tests/unit/native-auth-http-wiring.test.ts':
    'VL-10-002, unknown cause: its vi.mock of @workos-inc/node survives the next file\'s module reset',
};
// A fresh process per file, one at a time after the shared projects, for
// files that fail under CPU load.
const ALONE_UNIT_FILES: Record<string, string> = {
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
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(file, out);
    else if (TEST_FILE.test(entry.name)) out.push(file);
  }
  return out;
}

const unitFiles = [...testFiles('tests/unit'), ...testFiles('src')]
  .filter((file) => !(file in ISOLATED_UNIT_FILES) && !(file in ALONE_UNIT_FILES));
const freshFiles = new Set(unitFiles.filter((file) => NEEDS_FRESH_MODULES.test(readFileSync(path.join(ROOT, file), 'utf8'))));
// An empty include falls back to vitest's default pattern; match nothing.
const only = (files: string[]) => (files.length ? files : ['__no_files__']);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: ROOT,
    setupFiles: ['./tests/setup/revenue-tracking-env.ts', './tests/setup/conductor-loopback-setup.ts'],
    globalSetup: ['./tests/setup/built-schemas.ts'],
    env: validatorCacheEnv(process.env, path.dirname(ROOT)),
    testTimeout: 30000,
    pool: 'forks',
    maxWorkers: resolveWorkerCount({ reservedCpus: 1 }),
    // Undo vi.stubEnv / vi.stubGlobal before every test (the setup file also
    // undoes them before each file's imports).
    unstubEnvs: true,
    unstubGlobals: true,
    projects: [
      {
        // Workers are reused across files (`isolate: false`): modules, and
        // the caches they hold, load once per worker instead of once per
        // file. Files must leave env, globals, timers and module state as
        // they found them.
        extends: true,
        test: { name: 'unit-shared', include: only(unitFiles.filter((file) => !freshFiles.has(file))), isolate: false },
      },
      {
        // Reused workers too, but every file starts from a fresh module graph,
        // so its mocks and pre-import state reach every module it imports and
        // no later file inherits them. A worker only runs files of its own
        // project, so these resets never reach the `unit-shared` workers.
        // vitest queues projects by name: this one, which holds the longest
        // files, starts first.
        extends: true,
        test: {
          name: 'unit-fresh',
          include: only([...freshFiles]),
          isolate: false,
          setupFiles: ['./tests/setup/fresh-module-graph.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'unit-isolated', include: only(Object.keys(ISOLATED_UNIT_FILES)), isolate: true },
      },
      {
        // After the shared projects, so a load-sensitive file sees an idle
        // machine. Shares groupOrder 1 with `serial`; the two never have
        // files in the same run.
        extends: true,
        test: {
          name: 'unit-alone',
          include: only(Object.keys(ALONE_UNIT_FILES)),
          isolate: true,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        // Integration and other suites share one database and keep a fresh
        // process per file, one file at a time.
        extends: true,
        test: {
          name: 'serial',
          include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
          exclude: [...configDefaults.exclude, 'tests/unit/**'],
          isolate: true,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
