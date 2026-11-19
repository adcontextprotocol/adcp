// The cold-start warm-up (server/tests/setup/warm-caches.ts), a globalSetup
// that, before any worker starts, registers the training agent's schema roots
// once in a separate process with the workers' env, and transforms the
// training agent's module graph in the vitest server:
//   - server/vitest.config.ts runs it after built-schemas.ts;
//   - warmTransforms leaves a transform result in the server's module graph
//     for the entry and the repository modules it imports, never for
//     node_modules, and throws when an entry cannot be transformed;
//   - it starts no process when ADCP_VALIDATOR_CACHE_DIR is not an absolute
//     path (unset in CI, '' when the cache is off, relative: the SDK ignores it);
//   - setup(project) uses the env a worker gets: process.env, then the
//     resolved test.env (project.config.env).
// The SDK owns the cache entries and their cross-process reuse; one cold
// registration costs its full schema-root check (about 9 s on noetis-b-vm),
// too heavy for this suite, so the warm-up's effect is measured in fresh
// containers instead (adcp-testperf reports/stability-2). The cache is compared
// by .json file name and bytes only; nothing here reads entry contents.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestProject } from 'vitest/node';
import { childLaunchesSince, childLaunchMark } from '../helpers/child-process-launches.js';
import { createServer } from 'vite';
import setup, { TRAINING_AGENT_ENTRY_URL, warmSdkValidatorCache, warmTransforms } from '../setup/warm-caches.js';

// Pass-through recorder: every launch runs for real; tests read which child
// processes the warm-up started.
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../helpers/child-process-launches.js')).recordChildProcessLaunches(await importOriginal()));

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = dirname(SERVER_ROOT);
const WARMUP_MODULE = join(SERVER_ROOT, 'tests', 'setup', 'warm-caches.ts');
const BUILT_SCHEMAS_SETUP = join(SERVER_ROOT, 'tests', 'setup', 'built-schemas.ts');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, empty cache directory only this test can write (mode 0700). */
function freshCacheDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-validator-cache-warmup-')));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

/** Every .json file under `dir`: path relative to `dir` -> sha256 of its bytes. */
function jsonEntries(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        entries[relative(dir, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
    }
  };
  walk(dir);
  return entries;
}

/** Loads the real server config in a fresh node process and returns its resolved test.globalSetup. */
function resolvedGlobalSetup(): string[] {
  const script = [
    "const { pathToFileURL } = await import('node:url');",
    'const { default: config } = await import(pathToFileURL(process.argv[1]).href);',
    'process.stdout.write(JSON.stringify({ globalSetup: config.test?.globalSetup ?? [] }));',
  ].join('\n');
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const result = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script, join(SERVER_ROOT, 'vitest.config.ts')], {
    cwd: REPO_ROOT, env: process.env, encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const { globalSetup } = JSON.parse(result.stdout) as { globalSetup: string | string[] };
  return (Array.isArray(globalSetup) ? globalSetup : [globalSetup]).map((file) => resolve(SERVER_ROOT, file));
}

describe('server/vitest.config.ts globalSetup', () => {
  it('runs the cache warm-up after built-schemas.ts', () => {
    const mark = childLaunchMark();
    const setups = resolvedGlobalSetup();
    // Control for the no-launch cases below: the recorder sees this child.
    expect(childLaunchesSince(mark).map((launch) => launch.command)).toEqual([process.execPath]);
    expect(setups).toContain(BUILT_SCHEMAS_SETUP);
    expect(setups).toContain(WARMUP_MODULE);
    expect(setups.indexOf(WARMUP_MODULE), setups.join('\n')).toBeGreaterThan(setups.indexOf(BUILT_SCHEMAS_SETUP));
  });
});

/**
 * The parts of a TestProject the warm-up reads: the resolved test.env, and an
 * ssr environment whose every module transforms to empty code with no imports.
 */
const projectWithEnv = (env: Record<string, string>): TestProject => ({
  config: { env },
  vite: { environments: { ssr: { name: 'ssr', transformRequest: async () => ({ code: '', map: null, deps: [], dynamicDeps: [] }) } } },
}) as unknown as TestProject;

describe('warmTransforms', () => {
  it('transforms the training agent entry and the repository modules it imports in the server, skipping node_modules', async () => {
    const server = await createServer({
      root: SERVER_ROOT, configFile: false, logLevel: 'silent', appType: 'custom',
      server: { middlewareMode: true, hmr: false, ws: false },
    });
    try {
      const environment = server.environments.ssr!;
      const warmed = await warmTransforms(environment, [TRAINING_AGENT_ENTRY_URL]);
      for (const url of [TRAINING_AGENT_ENTRY_URL, '/src/training-agent/schema-compat.ts']) {
        expect(warmed, url).toContain(url);
        expect(environment.moduleGraph.getModuleById(join(SERVER_ROOT, url))?.transformResult, url).toBeTruthy();
      }
      expect([...warmed].filter((url) => url.includes('/node_modules/'))).toEqual([]);
      await expect(warmTransforms(environment, ['/src/training-agent/no-such-module.ts'])).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

describe('warmSdkValidatorCache', () => {
  it.each([
    ['unset', undefined],
    ["''", ''],
    ['a relative path', join('node_modules', '.cache', `sdk-validator-cache-warmup-${randomUUID()}`)],
  ])('starts no process when ADCP_VALIDATOR_CACHE_DIR is %s', async (_label, value) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
    delete env.ADCP_VALIDATOR_CACHE_DIR;
    if (value !== undefined) env.ADCP_VALIDATOR_CACHE_DIR = value;

    const mark = childLaunchMark();
    await warmSdkValidatorCache(env);
    expect(childLaunchesSince(mark)).toEqual([]);
    if (value) {
      for (const base of [REPO_ROOT, SERVER_ROOT, process.cwd()]) expect(existsSync(resolve(base, value)), base).toBe(false);
    }
  });
});

describe('default setup(project)', () => {
  it("lets the resolved test.env override process.env: '' there turns the warm-up off", async () => {
    const cacheDir = freshCacheDir();
    vi.stubEnv('ADCP_VALIDATOR_CACHE_DIR', cacheDir);

    const mark = childLaunchMark();
    await setup(projectWithEnv({ ADCP_VALIDATOR_CACHE_DIR: '' }));
    expect(childLaunchesSince(mark)).toEqual([]);
    expect(jsonEntries(cacheDir)).toEqual({});
  });
});
