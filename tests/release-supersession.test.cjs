#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isolateGitEnv } = require('./helpers/git-object-fixture.cjs');

// Fixture git (and every step spawned from process.env) must not see a hook's
// GIT_DIR/GIT_INDEX_FILE or the caller's git config; the fixtures set their own identity.
isolateGitEnv({ identity: false });

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
  write('scripts/check-release-state.cjs', fs.readFileSync(
    path.join(repositoryRoot, 'scripts', 'check-release-state.cjs'),
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
  const runPending = (extra = {}) => spawnSync(
    process.execPath,
    ['scripts/check-release-state.cjs', 'pending'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'adcontextprotocol/adcp',
        PUBLICATION_BRANCH: 'main',
        TESTED_SHA: git('rev-parse', 'HEAD'),
        ...extra,
      },
    },
  );
  return { root, git, run, runPending, changeset };
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

test('pending release fence accepts artifacts only through the reviewed supersession proof', (t) => {
  const f = fixture(t);
  const accepted = f.runPending();
  assert.equal(accepted.status, 0, accepted.stderr);

  fs.appendFileSync(path.join(f.root, '.changeset/fix.md'), 'Tampered.\n');
  const tampered = f.runPending();
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /Pending changesets differ/);
  fs.writeFileSync(path.join(f.root, '.changeset/fix.md'), f.changeset);

  fs.unlinkSync(path.join(f.root, '.changeset/release-supersession.json'));
  const unreviewed = f.runPending();
  assert.notEqual(unreviewed.status, 0);
  assert.match(unreviewed.stderr, /git ls-remote --exit-code/);
});

test('supersession tolerates unrelated commits but not new changesets or changed candidate bytes', (t) => {
  const f = fixture(t);

  // 3.3.0-rc.1 shape: a code fix without a changeset lands after the release
  // merge. It does not change the reviewed pool, so the marker stays valid.
  fs.mkdirSync(path.join(f.root, 'server'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'server/fix.ts'), 'export const fixed = true;\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'Unrelated fix without a changeset');
  const unrelated = f.run();
  assert.equal(unrelated.status, 0, unrelated.stderr);

  // Any changeset that lands after review changes the pool the next
  // candidate would consume, so main must stay frozen until it publishes.
  fs.writeFileSync(path.join(f.root, '.changeset/late.md'), '---\n"adcontextprotocol": patch\n---\n\nLate.\n');
  const late = f.run();
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /Pending changesets differ/);
  fs.unlinkSync(path.join(f.root, '.changeset/late.md'));

  fs.appendFileSync(path.join(f.root, 'dist/compliance/3.2.0-rc.5/index.yaml'), 'edited: true\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'Edit superseded bytes');
  const edited = f.run();
  assert.notEqual(edited.status, 0);
  assert.match(edited.stderr, /Superseded release artifacts changed after their release merge/);
});

test('the repository supersession marker binds its committed candidate', (t) => {
  const markerPath = path.join(repositoryRoot, '.changeset', 'release-supersession.json');
  if (!fs.existsSync(markerPath)) {
    t.skip('No pending supersession; the next Version Packages cut consumed it.');
    return;
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const gitInRepo = (...args) =>
    execFileSync(realGit, args, {
      cwd: repositoryRoot,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  assert.deepEqual(
    Object.keys(marker).sort(),
    ['changesets', 'protocol_sha256', 'reason', 'release_commit', 'version'],
  );
  assert.match(marker.version, /^\d+\.\d+\.\d+-rc\.\d+$/);
  assert.match(marker.release_commit, /^[a-f0-9]{40}$/);
  assert.ok(marker.reason.trim().length >= 40);

  const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, marker.version, 'The marker must name the committed candidate.');
  const { RELEASE_STATUS_OVERRIDES } = require(path.join(repositoryRoot, 'scripts', 'build-schemas.cjs'));
  assert.equal(
    RELEASE_STATUS_OVERRIDES.get(marker.version),
    'unpublished',
    'A superseded candidate must be unpublished in release discovery.',
  );

  // Read committed bytes from Git so a sparse checkout without dist/protocol
  // still checks the digest.
  const tarball = `dist/protocol/${marker.version}.tgz`;
  assert.equal(sha256(gitInRepo('cat-file', 'blob', `HEAD:${tarball}`)), marker.protocol_sha256);
  assert.equal(
    gitInRepo('cat-file', 'blob', `HEAD:${tarball}.sha256`).toString('utf8').split(/\s+/)[0],
    marker.protocol_sha256,
  );
  const releaseCommitAvailable = spawnSync(realGit, ['cat-file', '-e', `${marker.release_commit}^{commit}`], {
    cwd: repositoryRoot,
  }).status === 0;
  if (releaseCommitAvailable) {
    assert.equal(
      JSON.parse(gitInRepo('show', `${marker.release_commit}:package.json`).toString('utf8')).version,
      marker.version,
    );
    assert.equal(
      sha256(gitInRepo('cat-file', 'blob', `${marker.release_commit}:${tarball}`)),
      marker.protocol_sha256,
    );
  }

  const pending = fs
    .readdirSync(path.join(repositoryRoot, '.changeset'))
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(repositoryRoot, '.changeset', file))) }));
  assert.deepEqual(
    pending,
    [...marker.changesets].sort((a, b) => a.file.localeCompare(b.file)),
    'Pending changesets must match the reviewed supersession pool; keep main frozen until the next candidate publishes.',
  );
});
