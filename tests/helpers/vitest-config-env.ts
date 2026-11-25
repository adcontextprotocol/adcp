// Loads real vitest configs in this test worker, under the environment,
// working directory and argv a fresh process would have (withProcessState).
// resolvedTestEnv returns the test.env a config resolves (for the root
// config, its precommit:root project's: the root suite). Configs read
// process.env when they load, so each call replaces the environment, resets
// the module graph and imports the config afresh through vitest's own module
// runner: the config and every repository module it imports run again under
// that environment. cwd is a scratch directory while the config loads, so a
// default can only come from the config's own location. No child process: a
// config load costs milliseconds, where a fresh Node process with a
// TypeScript loader cost a second of CPU per case.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
// This worker's own runner state. The configs never read it, and vitest needs
// it while the config's imports resolve, so it stays in place.
const RUNNER_STATE = /^(VITEST|TINYPOOL)/;

interface ProcessState {
  /** The whole environment (this worker's runner state aside). */
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** process.argv, as a CLI would have it (a config may read --project from it). */
  argv?: string[];
}

let current: Promise<unknown> = Promise.resolve();

/**
 * Runs fn with this process's environment, working directory and argv
 * replaced, as a fresh process with that state would see them, and restores
 * them after (exit code included). Calls run one at a time, since the state
 * is the process's own.
 */
export function withProcessState<T>(state: ProcessState, fn: () => Promise<T>): Promise<T> {
  const run = current.then(async () => {
    const saved = { env: { ...process.env }, cwd: process.cwd(), argv: process.argv, exitCode: process.exitCode };
    const setEnv = (next: NodeJS.ProcessEnv) => {
      for (const key of Object.keys(process.env)) if (!RUNNER_STATE.test(key)) delete process.env[key];
      for (const [key, value] of Object.entries(next)) if (value !== undefined && !RUNNER_STATE.test(key)) process.env[key] = value;
    };
    setEnv(state.env);
    if (state.cwd) process.chdir(state.cwd);
    if (state.argv) process.argv = state.argv;
    try {
      return await fn();
    } finally {
      process.argv = saved.argv;
      process.chdir(saved.cwd);
      setEnv(saved.env);
      process.exitCode = saved.exitCode;
    }
  });
  current = run.catch(() => undefined);
  return run;
}

/**
 * @param config repository-relative config path
 * @param env the environment the config sees while it loads (runner state aside)
 * @param cwd working directory while the config loads
 */
export async function resolvedTestEnv(config: string, env: NodeJS.ProcessEnv, cwd: string): Promise<Record<string, string>> {
  const suite = rootSuite(await loadConfig(config, env, cwd));
  return { ...(suite?.env ?? {}) };
}

interface LoadedConfig {
  test?: { env?: Record<string, string>; projects?: Array<{ test?: { name?: string; env?: Record<string, string> } }> } & Record<string, unknown>;
}

/** The root suite's test options: the root config's precommit:root project, or a config's own test. */
export function rootSuite(config: LoadedConfig): (Record<string, unknown> & { env?: Record<string, string> }) | undefined {
  return config.test?.projects?.find((p) => p.test?.name === 'precommit:root')?.test ?? config.test;
}

/** The config's default export, loaded afresh under env with cwd as the working directory. */
export function loadConfig(config: string, env: NodeJS.ProcessEnv, cwd: string): Promise<LoadedConfig> {
  return withProcessState({ env, cwd }, async () => {
    vi.resetModules(); // lint-allow-resetmodules: each case loads the config under its own environment
    const url = pathToFileURL(path.join(REPO_ROOT, config)).href;
    const { default: loaded } = await import(/* @vite-ignore */ url);
    return loaded as LoadedConfig;
  });
}
