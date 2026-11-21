'use strict';
// Guard fixture: passes and leaves the caller repository alone, but commits in
// its own repository with the caller's git config (GIT_CONFIG_*) kept, so the
// caller's hooks run.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('commits with the caller git config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-env-isolation-hook-fixture-'));
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  try {
    const run = (args) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
    run(['init', '-q']);
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
