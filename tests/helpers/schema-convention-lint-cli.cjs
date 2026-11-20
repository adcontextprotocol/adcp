'use strict';

// Runs a schema convention lint through its command line, against the repo
// or against a fixture schema tree with its own baseline.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function runLint(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Writes `files` ({ 'dir/name.json': schema }) and a baseline with `entries`
 * to a temporary directory, runs the lint on them and removes the directory.
 */
function runOnFixture(script, files, entries = [], extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-convention-lint-'));
  try {
    const schemasDir = path.join(dir, 'schemas');
    for (const [file, schema] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(schemasDir, file)), { recursive: true });
      fs.writeFileSync(path.join(schemasDir, file), JSON.stringify(schema));
    }
    const baseline = path.join(dir, 'baseline.json');
    fs.writeFileSync(baseline, JSON.stringify({ $comment: 'fixture', entries }));
    return runLint(script, ['--schemas-dir', schemasDir, '--baseline', baseline, '--all', ...extraArgs]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The `[rule] site` pairs a run printed with --all. */
function findingsOf(output) {
  return [...output.matchAll(/^ {2}\[([a-z0-9-]+)\] (.+?): /gm)].map(([, rule, site]) => `${rule} ${site}`);
}

module.exports = { findingsOf, runLint, runOnFixture };
