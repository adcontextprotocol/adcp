'use strict';

// The @adcp/sdk validator cache for local vitest runs. The SDK keeps compiled
// bundled-schema validators and schema-root document identities in the
// directory ADCP_VALIDATOR_CACHE_DIR names, so only the first process
// compiles or scans them. server/vitest.config.ts and vitest.config.ts put
// the returned variables in test.env, which reaches every worker.
//
// Same default path and rule as scripts/run-storyboards-matrix.sh: unset
// gives <repo>/node_modules/.cache/adcp-sdk-validators, '' turns the cache
// off, any other value wins. Unlike the matrix, the unit suites get no
// default in CI: CI set to anything other than '', 'false' or '0' leaves the
// variable unset, so CI compiles every validator live.

const path = require('node:path');

const CACHE_DIR = path.join('node_modules', '.cache', 'adcp-sdk-validators');

function isCi(env) {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

/**
 * Variables to add to a vitest config's test.env: the default cache
 * directory, or nothing when the caller already set the variable or runs in CI.
 */
function validatorCacheEnv(env, repoRoot) {
  if (env.ADCP_VALIDATOR_CACHE_DIR !== undefined || isCi(env)) return {};
  return { ADCP_VALIDATOR_CACHE_DIR: path.join(repoRoot, CACHE_DIR) };
}

module.exports = { isCi, validatorCacheEnv };
