'use strict';

// Real git fixtures for fail-closed historical reads. Each repo commits one
// file, then optionally deletes the loose blob or tree object so a read of that
// object fails the way a failed lazy fetch does in a blobless clone.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The fixture's git must never see the caller's repository or configuration.
// Inside a hook the parent sets GIT_INDEX_FILE, GIT_DIR and friends; inherited,
// they would route `git add` into the caller's index. Every GIT_* variable is
// dropped, and global and system config are ignored so caller hooks, signing
// and templates cannot run. HOME and the parent environment are left alone.
function fixtureEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
}

function gitIn(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: fixtureEnv(),
  });
}

function removeLooseObject(repo, oid) {
  fs.rmSync(path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
}

/**
 * Creates a repo with `filePath` containing `content` committed on HEAD.
 * `missing` is 'none', 'blob' (file contents unavailable) or 'tree' (the
 * file's parent directory tree unavailable).
 */
function gitFixture({ filePath, content, missing = 'none' }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-git-fixture-'));
  gitIn(repo, ['init', '-q']);
  fs.mkdirSync(path.join(repo, path.dirname(filePath)), { recursive: true });
  fs.writeFileSync(path.join(repo, filePath), content);
  gitIn(repo, ['add', '.']);
  gitIn(repo, ['commit', '-q', '-m', 'fixture']);
  if (missing === 'blob') removeLooseObject(repo, gitIn(repo, ['rev-parse', `HEAD:${filePath}`]).trim());
  if (missing === 'tree') removeLooseObject(repo, gitIn(repo, ['rev-parse', `HEAD:${path.posix.dirname(filePath)}`]).trim());
  const runGit = (args) => gitIn(repo, args);
  return { repo, runGit, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

module.exports = { fixtureEnv, gitFixture };
