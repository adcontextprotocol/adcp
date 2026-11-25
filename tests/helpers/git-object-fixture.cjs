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
// Pass { identity: false } when the code under test sets its own commit
// identity: an author/committer in the environment would override it.
function fixtureEnv({ identity = true } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    ...(identity ? {
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    } : {}),
  };
}

// Applies fixtureEnv to process.env in place, for test files whose fixture git
// runs in many places: their own helpers, workflow steps they spawn with
// { ...process.env }, and wrapper scripts that call the real git. Inside a
// linked-worktree hook git exports GIT_DIR=<repo>/.git/worktrees/<name> and
// GIT_INDEX_FILE; inherited, they make fixture commands commit, tag and fetch
// into the caller's repository, and make `git init` write core.bare=true into
// its shared config. Call it at module scope, before the first git launch.
// Returns a function that restores the previous environment (for runners
// that reuse the process across files).
function isolateGitEnv(options) {
  const previous = { ...process.env };
  const isolated = fixtureEnv(options);
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(isolated, key)) delete process.env[key];
  Object.assign(process.env, isolated);
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
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

// For a test that reads the enclosing checkout on purpose
// (lint-allow-caller-git): the environment without GIT_*, so git finds the
// checkout from its working directory. In a real hook the dropped GIT_DIR names
// this same checkout; under tests/git-env-isolation.test.cjs it names a
// throwaway repository, and the read would see that one instead.
function checkoutGitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}
module.exports = { checkoutGitEnv, fixtureEnv, gitFixture, isolateGitEnv };
