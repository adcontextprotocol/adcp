'use strict';

// Loads a real vitest config in a fresh Node process (through tsx, as vitest
// would) and returns the test.env it resolves (for the root config, its
// precommit:root project's: the root suite). Configs read process.env at
// load, so each case gets its own process and environment; cwd is a scratch
// directory, so a default can only come from the config's own location.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;

/**
 * @param {string} config repository-relative config path
 * @param {NodeJS.ProcessEnv} env the child's whole environment
 * @param {string} cwd working directory for the child
 * @returns {{ status: number | null, stderr: string, env: Record<string, string> }}
 */
function resolvedTestEnv(config, env, cwd) {
  const script = [
    "const { pathToFileURL } = await import('node:url');",
    'const { default: config } = await import(pathToFileURL(process.argv[1]).href);',
    // A config with projects (the root one) keeps the root suite's options in
    // its precommit:root project.
    "const suite = config.test?.projects?.find((p) => p.test?.name === 'precommit:root')?.test ?? config.test;",
    'process.stdout.write(JSON.stringify({ env: suite?.env ?? {} }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', script, path.join(REPO_ROOT, config)], {
    cwd, env, encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    env: result.status === 0 ? JSON.parse(result.stdout).env : {},
  };
}

module.exports = { resolvedTestEnv };
