'use strict';

// Node's compile cache for server-suite workers. server/vitest.config.ts puts
// the returned variable in test.env; vitest merges test.env into each fork's
// environment when it spawns the fork, so Node starts with the cache on and
// compiles the modules it loads natively (externalized node_modules, the SDK
// among them) once across workers and runs. vitest flushes each fork's cache
// when it stops the fork, and drops the variable itself under v8 coverage.
//
// Same default path and rule as .husky/pre-push: unset gives
// <repo>/node_modules/.cache/node-compile-cache, '' turns the cache off, any
// other value wins, and NODE_DISABLE_COMPILE_CACHE (Node's own switch) leaves
// it off. Unlike the validator cache there is no CI exception: Node keys the
// directory by its version, architecture and flags, and checks each entry
// against its module's source hash, so a changed file is a miss, never a
// stale hit.

const path = require('node:path');

const CACHE_DIR = path.join('node_modules', '.cache', 'node-compile-cache');

/**
 * Variables to add to a vitest config's test.env: the default cache
 * directory, or nothing when the caller already set or disabled the cache.
 */
function compileCacheEnv(env, repoRoot) {
  if (env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined) return {};
  return { NODE_COMPILE_CACHE: path.join(path.resolve(repoRoot), CACHE_DIR) };
}

module.exports = { compileCacheEnv };
