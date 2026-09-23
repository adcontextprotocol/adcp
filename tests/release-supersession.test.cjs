#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-supersession-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-supersession-remote-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });
  const write = (relative, value, mode) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
    if (mode) fs.chmodSync(target, mode);
  };
  const git = (...args) =>
    execFileSync(realGit, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  write('scripts/check-release-supersession.cjs', fs.readFileSync(
    path.join(repositoryRoot, 'scripts', 'check-release-supersession.cjs'),
  ));
  write('package.json', '{"version":"3.2.0-rc.4"}\n');
  write('.changeset/pre.json', '{"mode":"pre","tag":"rc"}\n');
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'Prior candidate');

  const version = '3.2.0-rc.5';
  write('package.json', `${JSON.stringify({ version })}\n`);
  write(`dist/schemas/${version}/index.json`, '{"schema":true}\n');
  write(`dist/compliance/${version}/index.yaml`, 'version: 1\n');
  for (const suffix of ['', '.sha256', '.sig', '.crt']) {
    write(`dist/protocol/${version}.tgz${suffix}`, `protocol${suffix}\n`);
  }
  git('add', '.');
  git('commit', '-qm', 'Version Packages');
  const releaseCommit = git('rev-parse', 'HEAD');

  const changeset = '---\n"adcontextprotocol": patch\n---\n\nRelease blocker.\n';
  write('.changeset/fix.md', changeset);
  write('.changeset/release-supersession.json', `${JSON.stringify({
    version,
    release_commit: releaseCommit,
    protocol_sha256: sha256('protocol\n'),
    reason: 'The committed candidate lacks release authority and must advance through a newly reviewed candidate.',
    changesets: [{ file: 'fix.md', sha256: sha256(changeset) }],
  }, null, 2)}\n`);
  write('bin/gh', `#!/bin/sh
if [ "${'${GH_RELEASE_EXISTS:-}'}" = true ]; then
  printf '%s\\n' '{"tag_name":"v3.2.0-rc.5"}'
  exit 0
fi
printf '%s\\n' 'gh: Not Found (HTTP 404)' >&2
exit 1
`, 0o755);
  git('add', '.');
  git('commit', '-qm', 'Authorize supersession');
  execFileSync(realGit, ['init', '--bare', '-q', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'HEAD:main');

  const run = (extra = {}) => spawnSync(
    process.execPath,
    ['scripts/check-release-supersession.cjs', 'verify'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'adcontextprotocol/adcp',
        ...extra,
      },
    },
  );
  return { root, git, run, changeset };
}

test('reviewed supersession verifies immutable unpublished RC and exact changesets', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);

  fs.appendFileSync(path.join(f.root, '.changeset/fix.md'), 'Tampered.\n');
  const changed = f.run();
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Pending changesets differ/);
  fs.writeFileSync(path.join(f.root, '.changeset/fix.md'), f.changeset);

  const existingRelease = f.run({ GH_RELEASE_EXISTS: 'true' });
  assert.notEqual(existingRelease.status, 0);
  assert.match(existingRelease.stderr, /already exists/);

  f.git('tag', 'v3.2.0-rc.5');
  f.git('push', '-q', 'origin', 'v3.2.0-rc.5');
  const tagged = f.run();
  assert.notEqual(tagged.status, 0);
  assert.match(tagged.stderr, /Tag v3\.2\.0-rc\.5 already exists/);
});

