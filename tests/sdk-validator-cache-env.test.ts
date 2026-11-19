// The @adcp/sdk validator cache (ADCP_VALIDATOR_CACHE_DIR) for the server
// unit suite (server/vitest.config.ts) and test:unit (vitest.config.ts):
//   - each config's test.env defaults the variable to
//     <root>/node_modules/.cache/adcp-sdk-validators, the path
//     scripts/run-storyboards-matrix.sh exports, so both share one cache;
//   - a value the shell already set, including '' (cache off), passes through:
//     the config adds no override;
//   - CI gets no default: CI set to anything other than '', 'false' or '0'
//     turns it off (only CI is read). The matrix keeps its own rule.
// Each case loads the real config in a child process with a cleaned env and
// asserts the test.env it resolves; nothing here asserts on time or on what
// the cache holds (the SDK owns its read and write paths).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import vitestConfigEnv from './helpers/vitest-config-env.cjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CACHE = join(REPO_ROOT, 'node_modules', '.cache', 'adcp-sdk-validators');
const CONFIGS = ['server/vitest.config.ts', 'vitest.config.ts'];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An empty working directory, so a default can only come from the config's own location. */
function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-validator-cache-env-')));
  dirs.push(dir);
  return dir;
}

/** Child env without the cache variable, CI, or inherited test-runner state. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ADCP_VALIDATOR_CACHE_DIR|CI|NODE_OPTIONS|VITEST.*|TEST|NODE_ENV|npm_.*)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** Loads the real config in a fresh node process and returns its resolved test.env ({} when unset). */
function resolvedTestEnv(config: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const result = vitestConfigEnv.resolvedTestEnv(config, env, scratchDir());
  expect(result.status, result.stderr).toBe(0);
  return result.env;
}

describe.each(CONFIGS)('%s: ADCP_VALIDATOR_CACHE_DIR', (config) => {
  it('defaults to <root>/node_modules/.cache/adcp-sdk-validators when the variable is unset', () => {
    expect(resolvedTestEnv(config, cleanEnv())).toMatchObject({ ADCP_VALIDATOR_CACHE_DIR: DEFAULT_CACHE });
  });

  it.each([
    ["''", { ADCP_VALIDATOR_CACHE_DIR: '' }],
    ['a custom absolute path', { ADCP_VALIDATOR_CACHE_DIR: join(tmpdir(), 'custom-adcp-sdk-validators') }],
  ])('adds no override when the shell sets it to %s', (_label, extra) => {
    expect(resolvedTestEnv(config, cleanEnv(extra))).not.toHaveProperty('ADCP_VALIDATOR_CACHE_DIR');
  });

  it.each(['true', '1'])('adds no default when CI=%s', (ci) => {
    expect(resolvedTestEnv(config, cleanEnv({ CI: ci }))).not.toHaveProperty('ADCP_VALIDATOR_CACHE_DIR');
  });

  it.each(['false', '0', ''])("defaults to the shared path when CI='%s'", (ci) => {
    expect(resolvedTestEnv(config, cleanEnv({ CI: ci }))).toMatchObject({ ADCP_VALIDATOR_CACHE_DIR: DEFAULT_CACHE });
  });
});

// A vitest config file at any depth: vitest.config.*, vitest.<name>.config.*
// or a workspace file. Every one must be in CONFIGS, so a new config cannot
// start workers without the shared cache unnoticed.
const VITEST_CONFIG = /(^|\/)vitest(\.[\w-]+)?\.(config|workspace)\.[cm]?[jt]s$/;

describe('every vitest config in the repository', () => {
  it('recognizes vitest config file names and nothing else', () => {
    for (const file of ['vitest.config.ts', 'server/vitest.config.ts', 'apps/x/vitest.config.mts', 'vitest.e2e.config.js', 'vitest.workspace.ts']) {
      expect(VITEST_CONFIG.test(file), file).toBe(true);
    }
    for (const file of ['vite.config.ts', 'tests/vitest-config.test.ts', 'server/vitest.config.ts.orig', 'scripts/vitest.cjs']) {
      expect(VITEST_CONFIG.test(file), file).toBe(false);
    }
  });

  it('is one of the configs checked above', () => {
    // lint-allow-caller-git: lists the enclosing checkout's own files
    const result = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const configs = result.stdout.split('\n').filter((file) => VITEST_CONFIG.test(file)).sort();
    expect(configs).toEqual([...CONFIGS].sort());
  });
});

describe('scripts/run-storyboards-matrix.sh: ADCP_VALIDATOR_CACHE_DIR', () => {
  function exportLine(): string {
    const lines = readFileSync(join(REPO_ROOT, 'scripts', 'run-storyboards-matrix.sh'), 'utf8')
      .split('\n')
      .filter((line) => /^\s*export ADCP_VALIDATOR_CACHE_DIR=/.test(line));
    expect(lines, 'one `export ADCP_VALIDATOR_CACHE_DIR=` line in scripts/run-storyboards-matrix.sh').toHaveLength(1);
    return lines[0];
  }

  it('exports the same default path the unit configs resolve', () => {
    const result = spawnSync('/bin/sh', ['-c', `${exportLine()}\nprintf '%s' "$ADCP_VALIDATOR_CACHE_DIR"`], {
      cwd: scratchDir(), env: cleanEnv({ REPO_ROOT }), encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(DEFAULT_CACHE);
    for (const config of CONFIGS) {
      expect(resolvedTestEnv(config, cleanEnv()), config).toMatchObject({ ADCP_VALIDATOR_CACHE_DIR: result.stdout });
    }
  });
});
