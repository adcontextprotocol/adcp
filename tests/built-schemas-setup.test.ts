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
// the tree. Nothing here asserts on time.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { BUILT_SCHEMA_FILES } from './setup/built-schemas.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'global-setup-paths');
const TOOL_GATES = 'tests/addie/compliance-authored-tool-gates.test.ts';

const run = promisify(execFile);
const dirs: string[] = [];

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
    const script = [
      "const { pathToFileURL } = await import('node:url');",
      'const { default: config } = await import(pathToFileURL(process.argv[1]).href);',
      // The root suite's options live in the config's precommit:root project.
      "const suite = config.test.projects.find((p) => p.test?.name === 'precommit:root').test;",
      'process.stdout.write(JSON.stringify([suite.globalSetup ?? []].flat()));',
    ].join('\n');
    const { stdout } = await run(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', script, join(REPO_ROOT, 'vitest.config.ts')], {
      cwd: REPO_ROOT, env: cleanEnv(), encoding: 'utf8',
    });
    expect(JSON.parse(stdout)).toEqual(['./tests/setup/built-schemas.ts']);
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
    const recorded = async (args: string[], name: string): Promise<string[]> => {
      const file = join(out, `${name}.json`);
      await run(process.execPath, [VITEST_BIN, 'run', '--config', join(FIXTURE, 'global-setup-paths.config.ts'), ...args], {
        cwd: FIXTURE, env: cleanEnv({ GLOBAL_SETUP_PATHS_OUT: file }), encoding: 'utf8',
      });
      return (JSON.parse(readFileSync(file, 'utf8')) as string[]).map((path) => path.slice(FIXTURE.length + 1)).sort();
    };
    expect(await recorded(['a.fixture.ts'], 'one')).toEqual(['a.fixture.ts']);
    expect(await recorded([], 'all')).toEqual(['a.fixture.ts', 'b.fixture.ts']);
  });
});
