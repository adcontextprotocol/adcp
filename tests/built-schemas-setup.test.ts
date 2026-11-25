// The root suite's globalSetup, tests/setup/built-schemas.ts (tp-jyw.46):
//   - vitest.config.ts runs it;
//   - it builds dist/schemas/latest once, before any worker starts, only for
//     a run that includes a file in BUILT_SCHEMA_FILES, and every listed file
//     exists;
//   - it relies on vitest having collected the run's files into its state
//     when global setups start; a real vitest run on a fixture config pins
//     that, so an upgrade that changes the order fails here instead of
//     silently testing against a stale tree.
// The build itself is replaced by a recorder, so nothing here builds or reads
// the tree. Nothing here asserts on time. The config and the fixture's vitest
// runs load in this worker (tests/helpers/vitest-config-env.ts), under the
// environment and argv their processes would have had; neither starts a
// process.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { loadConfig, rootSuite, withProcessState } from './helpers/vitest-config-env.ts';
import setup, { BUILT_SCHEMA_FILES } from './setup/built-schemas.js';

// Before any import, so a launcher a module destructures is counted too.
const spawns = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('./helpers/spawn-counter.cjs').install() as { count: number; commands: string[] };
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'global-setup-paths');
const TOOL_GATES = 'tests/addie/compliance-authored-tool-gates.test.ts';

const dirs: string[] = [];
const discard = () => new Writable({ write(_chunk, _encoding, done) { done(); } });

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Child env without inherited vitest or node:test state. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(VITEST.*|NODE_TEST.*|NODE_OPTIONS|TEST)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** A project as the setup reads it: the config root and the run's collected files. */
function project(paths: string[]) {
  return {
    config: { root: REPO_ROOT },
    vitest: { state: { getPaths: () => paths.map((file) => resolve(REPO_ROOT, file)) } },
  } as unknown as Parameters<typeof setup>[0];
}

/** Calls the setup with a recorder in place of the build; returns how often it would build. */
function builds(paths: string[]): number {
  let count = 0;
  setup(project(paths), () => {
    count += 1;
    return '';
  });
  return count;
}

describe('tests/setup/built-schemas.ts', () => {
  it('is the root vitest config globalSetup', async () => {
    const before = spawns.count;
    // The root suite's options live in the config's precommit:root project.
    const suite = rootSuite(await loadConfig('vitest.config.ts', cleanEnv(), REPO_ROOT));
    expect([suite?.globalSetup ?? []].flat()).toEqual(['./tests/setup/built-schemas.ts']);
    expect(spawns.commands.slice(before), 'loading the config starts no process').toEqual([]);
  });

  it('lists only files that exist, the tool-gates file among them', () => {
    expect(BUILT_SCHEMA_FILES).toContain(TOOL_GATES);
    expect(BUILT_SCHEMA_FILES.filter((file) => !existsSync(join(REPO_ROOT, file)))).toEqual([]);
  });

  it('builds once for a run that includes a listed file', () => {
    expect(builds([TOOL_GATES])).toBe(1);
    expect(builds(['tests/precommit-hook-guards.test.ts', TOOL_GATES, 'tests/node-compile-cache.test.ts'])).toBe(1);
  });

  it('builds nothing for a run without a listed file', () => {
    expect(builds(['tests/precommit-hook-guards.test.ts'])).toBe(0);
    expect(builds(['server/tests/unit/certification-demo-formatting.test.ts'])).toBe(0);
    expect(builds([])).toBe(0);
  });

  it("sees exactly the run's files: vitest collects them before global setups start", async () => {
    const out = mkdtempSync(join(tmpdir(), 'global-setup-paths-'));
    dirs.push(out);
    const config = join(FIXTURE, 'global-setup-paths.config.ts');
    // `vitest run --config <fixture config> [filter]` from the fixture directory.
    const recorded = async (filters: string[], name: string): Promise<string[]> => {
      const file = join(out, `${name}.json`);
      const argv = [process.execPath, VITEST_BIN, 'run', '--config', config, ...filters];
      const exitCode = await withProcessState({ env: cleanEnv({ GLOBAL_SETUP_PATHS_OUT: file }), cwd: FIXTURE, argv }, async () => {
        await startVitest('test', filters, { config, watch: false, run: true }, {}, { stdout: discard(), stderr: discard() });
        return process.exitCode ?? 0;
      });
      expect(exitCode, `vitest run ${filters.join(' ')} passes`).toBe(0);
      return (JSON.parse(readFileSync(file, 'utf8')) as string[]).map((path) => path.slice(FIXTURE.length + 1)).sort();
    };
    const before = spawns.count;
    expect(await recorded(['a.fixture.ts'], 'one')).toEqual(['a.fixture.ts']);
    expect(await recorded([], 'all')).toEqual(['a.fixture.ts', 'b.fixture.ts']);
    expect(spawns.commands.slice(before), 'the fixture runs start no process (threads pool)').toEqual([]);
  });
});
