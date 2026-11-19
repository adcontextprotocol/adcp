import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/**
 * vitest globalSetup, after built-schemas.ts. Does once, before any worker
 * starts, the cold work that the first training-agent setup in every worker
 * would otherwise repeat or queue for. In a fresh checkout or container all
 * 38 workers start at once with empty caches, and a training-agent beforeAll
 * that runs first in its worker could pass its 10 s limit.
 *
 * - SDK validator cache: constructing the training agent registers its
 *   schema roots with @adcp/sdk, and the first registration against an empty
 *   ADCP_VALIDATOR_CACHE_DIR checks every schema document (about 6 CPU-s).
 *   A child process with the workers' env registers them once; workers then
 *   read the SDK's entries. The child also fills Node's compile cache for the
 *   modules it loads natively.
 * - Transforms: on an empty fsModuleCache the vitest server transforms each
 *   module when the first worker asks for it, one request at a time, while
 *   38 workers ask. This process transforms the training agent's module graph
 *   while the child runs; workers then find the results in the server's
 *   module graph.
 */
export default async function setup(project: TestProject): Promise<void> {
  await Promise.all([
    warmSdkValidatorCache({ ...process.env, ...project.config.env, NODE_ENV: 'test' }),
    warmTransforms(project.vite.environments.ssr!, [TRAINING_AGENT_ENTRY_URL]),
  ]);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** The child entry: the schema-root registrations a worker makes for the training agent. */
export const REGISTRATION_ENTRY = fileURLToPath(new URL('./register-training-agent-schema-roots.ts', import.meta.url));
/** The training agent's entry, as a url of the server's Vite root (server/). */
export const TRAINING_AGENT_ENTRY_URL = '/src/training-agent/index.ts';

/**
 * Registers the training agent's schema roots in a child process with `env`.
 * Does nothing unless the env names an absolute cache directory, the SDK's
 * own rule (CI leaves it unset; '' turns it off). Throws if the child fails.
 */
export function warmSdkValidatorCache(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = env.ADCP_VALIDATOR_CACHE_DIR;
  if (!dir || !path.isAbsolute(dir)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', REGISTRATION_ENTRY], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`SDK validator cache warm-up (${REGISTRATION_ENTRY}) exited with ${signal ?? `code ${code}`}`));
    });
  });
}

type DevEnvironment = TestProject['vite']['environments'][string];

/**
 * Transforms each entry and every repository module it imports, statically or
 * dynamically, in `environment`. node_modules are skipped (vitest externalizes
 * them). An entry that fails to transform throws; a failing import is left for
 * the worker that imports it to report. Returns the urls transformed.
 */
export async function warmTransforms(environment: DevEnvironment, entryUrls: readonly string[]): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const visit = async (url: string): Promise<void> => {
    if (seen.has(url) || !url.startsWith('/') || url.includes('/node_modules/')) return;
    seen.add(url);
    const result = await environment.transformRequest(url).catch(() => null);
    if (!result) return;
    await Promise.all([...(result.deps ?? []), ...(result.dynamicDeps ?? [])].map(visit));
  };
  await Promise.all(entryUrls.map(async (url) => {
    if (!await environment.transformRequest(url)) throw new Error(`Cannot transform ${url} in the ${environment.name} environment`);
    await visit(url);
  }));
  return seen;
}
