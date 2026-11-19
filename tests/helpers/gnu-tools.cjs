'use strict';
/**
 * The release scripts run on GitHub's Ubuntu runners and call two GNU
 * coreutils that macOS lacks: `stat -c '%a'` (scripts/backfill-cdn-artifacts.sh)
 * and `timeout` (scripts/fence-changesets.cjs, .github/workflows/release.yml).
 * provideGnuTools() puts a shim for each missing tool first on PATH, for this
 * process and every script its tests run. Each tool is probed by running it,
 * so a host that has it (Linux, or Homebrew coreutils' gnubin) keeps its PATH
 * and runs the real tool. Returns the names of the shimmed tools.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SHIMS = path.join(__dirname, 'gnu-tools');

const works = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;

function provideGnuTools() {
  const missing = [];
  if (!works('stat', ['-c', '%a', '/'])) missing.push('stat');
  if (!works('timeout', ['--version'])) missing.push('timeout');
  if (missing.length > 0) {
    process.env.PATH = [...missing.map((tool) => path.join(SHIMS, tool)), process.env.PATH].join(path.delimiter);
  }
  return missing;
}

module.exports = { provideGnuTools };
