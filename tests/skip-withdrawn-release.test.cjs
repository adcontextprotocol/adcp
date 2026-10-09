#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const loadModule = () => import('../scripts/skip-withdrawn-release.mjs');

const REASON = 'An accidental Version Packages cut exposed immutable 3.2.0 artifacts that are never overwritten or retired.';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// A miniature history: the accidental 3.2.0 cut, its revert, then an RC line.
function fixture(t, { preMode = 'pre' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-withdrawn-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const setVersion = (version) => write('package.json', `${JSON.stringify({ name: 'adcontextprotocol', version }, null, 2)}\n`);

  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  setVersion('3.1.1');
  write('CHANGELOG.md', '# Changelog\n\n## 3.1.1\n\n- Prior.\n');
  git('add', '.');
  git('commit', '-qm', 'Prior stable');

  setVersion('3.2.0');
  for (const suffix of ['', '.sha256', '.sig', '.crt']) {
    write(`dist/protocol/3.2.0.tgz${suffix}`, `withdrawn${suffix}\n`);
  }
  git('add', '.');
  git('commit', '-qm', 'Version Packages');
  const withdrawnCommit = git('rev-parse', 'HEAD');
  git('revert', '--no-edit', 'HEAD');
  const revertCommit = git('rev-parse', 'HEAD');

  setVersion('3.2.0-rc.7');
  write('CHANGELOG.md', '# Changelog\n\n## 3.2.0-rc.7\n\n- Candidate.\n\n## 3.1.1\n\n- Prior.\n');
  write('.changeset/pre.json', `${JSON.stringify({ mode: preMode, tag: 'rc' }, null, 2)}\n`);
  write('.changeset/pre/archived-feature.md', '---\n"adcontextprotocol": minor\n---\n\nArchived feature.\n');
  write('.changeset/pending-fix.md', '---\n"adcontextprotocol": patch\n---\n\nPending fix.\n');
  const marker = {
    withdrawn_version: '3.2.0',
    target_version: '3.2.1',
    withdrawn_release_commit: withdrawnCommit,
    revert_commit: revertCommit,
    withdrawn_protocol_sha256: sha256('withdrawn\n'),
    reason: REASON,
  };
  const writeMarker = (value) => write('.changeset/withdrawn-release.json', `${JSON.stringify(value, null, 2)}\n`);
  writeMarker(marker);
  git('add', '.');
  git('commit', '-qm', 'RC line with reviewed marker');

  // Simulates `changeset version`: consumes the whole pool, drops pre state.
  const fakeChangesetVersion = (generated) => () => {
    fs.rmSync(path.join(root, '.changeset/pending-fix.md'));
    fs.rmSync(path.join(root, '.changeset/pre'), { recursive: true });
    if (!String(generated).includes('-')) fs.rmSync(path.join(root, '.changeset/pre.json'));
    setVersion(generated);
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    write('CHANGELOG.md', changelog.replace('# Changelog\n\n', `# Changelog\n\n## ${generated}\n\n### Minor Changes\n\n- Archived feature.\n\n`));
  };
  const options = (extra = {}) => ({
    verifyNonSelectable: async () => {},
    verifyNeverPublished: () => {},
    setPackageVersion: (_root, version) => setVersion(version),
    ...extra,
  });
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  return { root, git, marker, writeMarker, setVersion, write, read, fakeChangesetVersion, options };
}

test('marker shape binds the withdrawn number, next patch, commits, digest, and reason', async () => {
  const { validateMarkerShape } = await loadModule();
  const good = {
    withdrawn_version: '3.2.0',
    target_version: '3.2.1',
    withdrawn_release_commit: 'a'.repeat(40),
    revert_commit: 'b'.repeat(40),
    withdrawn_protocol_sha256: 'c'.repeat(64),
    reason: REASON,
  };
  assert.equal(validateMarkerShape(good), good);
  assert.throws(() => validateMarkerShape({ ...good, extra: true }), /unexpected shape/);
  assert.throws(() => validateMarkerShape({ ...good, target_version: '3.2.2' }), /next patch after 3\.2\.0/);
  assert.throws(() => validateMarkerShape({ ...good, withdrawn_version: '3.2.0-rc.5', target_version: '3.2.0' }), /exact stable/);
  assert.throws(() => validateMarkerShape({ ...good, revert_commit: 'abc' }), /full withdrawn_release_commit and revert_commit/);
  assert.throws(() => validateMarkerShape({ ...good, withdrawn_protocol_sha256: 'nope' }), /SHA-256/);
  assert.throws(() => validateMarkerShape({ ...good, reason: 'short' }), /concrete reviewed reason/);
});

test('plan passes prerelease cuts through and skips only on the pre-exit cut', async () => {
  const { planWithdrawnSkip } = await loadModule();
  const marker = { withdrawn_version: '3.2.0', target_version: '3.2.1' };
  assert.deepEqual(
    planWithdrawnSkip({ packageVersion: '3.2.0-rc.7', preState: { mode: 'pre', tag: 'rc' }, marker }),
    { mode: 'passthrough', currentVersion: '3.2.0-rc.7' },
  );
  assert.deepEqual(
    planWithdrawnSkip({ packageVersion: '3.2.0-rc.7', preState: { mode: 'exit', tag: 'rc' }, marker }),
    { mode: 'skip', currentVersion: '3.2.0-rc.7', withdrawnVersion: '3.2.0', targetVersion: '3.2.1' },
  );
  assert.throws(
    () => planWithdrawnSkip({ packageVersion: '3.2.1', preState: null, marker }),
    /stale/,
  );
  assert.throws(
    () => planWithdrawnSkip({ packageVersion: '3.3.0-beta.0', preState: { mode: 'pre', tag: 'beta' }, marker }),
    /prerelease line is 3\.3\.0/,
  );
  assert.throws(
    () => planWithdrawnSkip({ packageVersion: '3.2.0-rc.7', preState: null, marker }),
    /requires Changesets pre mode/,
  );
});

test('the committed marker verifies against real history and release discovery', async (t) => {
  const markerPath = path.join(repositoryRoot, '.changeset/withdrawn-release.json');
  if (!fs.existsSync(markerPath)) {
    t.skip('marker already consumed by the GA Version Packages cut');
    return;
  }
  const { readMarker, verifyMarker, verifyNonSelectable } = await loadModule();
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim() === 'true';
  if (shallow) {
    // CI checkouts may lack the June 2026 history; still bind shape and discovery.
    const marker = readMarker(repositoryRoot);
    await verifyNonSelectable(repositoryRoot, marker);
    return;
  }
  const { marker, plan } = await verifyMarker(repositoryRoot, { verifyNeverPublished: () => {} });
  assert.equal(marker.withdrawn_version, '3.2.0');
  assert.equal(marker.target_version, '3.2.1');
  assert.ok(['passthrough', 'skip'].includes(plan.mode));
});

test('pre-exit cut ships the next patch and retitles the generated changelog', async (t) => {
  const f = fixture(t, { preMode: 'exit' });
  const { versionWithWithdrawnMarker } = await loadModule();
  let remoteChecked = false;
  const result = await versionWithWithdrawnMarker(f.root, f.options({
    runChangesetVersion: f.fakeChangesetVersion('3.2.0'),
    verifyNeverPublished: () => { remoteChecked = true; },
  }));
  assert.deepEqual(result, { mode: 'skip', version: '3.2.1', skipped: '3.2.0' });
  assert.equal(remoteChecked, true, 'the pre-exit cut must prove the withdrawn number was never published');
  assert.equal(JSON.parse(f.read('package.json')).version, '3.2.1');
  const changelog = f.read('CHANGELOG.md');
  assert.match(changelog, /^# Changelog\n\n## 3\.2\.1\n\nThis is the first stable 3\.2 release\. `3\.2\.0` is a permanently withdrawn version number and was never released\. An accidental/);
  assert.match(changelog, /\n### Minor Changes\n\n- Archived feature\.\n/);
  assert.doesNotMatch(changelog, /^## 3\.2\.0$/m);
  assert.equal(fs.existsSync(path.join(f.root, '.changeset/withdrawn-release.json')), false);
});

test('ordinary prerelease cuts leave the marker in place', async (t) => {
  const f = fixture(t);
  const { versionWithWithdrawnMarker } = await loadModule();
  const result = await versionWithWithdrawnMarker(f.root, f.options({
    runChangesetVersion: () => f.setVersion('3.2.0-rc.8'),
    verifyNeverPublished: () => assert.fail('prerelease cuts stay offline'),
  }));
  assert.deepEqual(result, { mode: 'passthrough', version: '3.2.0-rc.8' });
  assert.equal(fs.existsSync(path.join(f.root, '.changeset/withdrawn-release.json')), true);
});

test('prerelease cuts that leave the withdrawn line fail on the cut that caused it', async (t) => {
  const f = fixture(t);
  const { versionWithWithdrawnMarker } = await loadModule();
  await assert.rejects(
    versionWithWithdrawnMarker(f.root, f.options({ runChangesetVersion: () => f.setVersion('4.0.0-rc.0') })),
    /outside the 3\.2\.0 prerelease line/,
  );
});

test('fails closed on history, digest, artifact, and generation mismatches', async (t) => {
  const f = fixture(t, { preMode: 'exit' });
  const { verifyMarker, versionWithWithdrawnMarker } = await loadModule();

  f.writeMarker({ ...f.marker, withdrawn_protocol_sha256: sha256('other') });
  await assert.rejects(verifyMarker(f.root, f.options()), /does not match the reviewed digest/);

  f.writeMarker({ ...f.marker, revert_commit: f.marker.withdrawn_release_commit });
  await assert.rejects(verifyMarker(f.root, f.options()), /directly revert/);

  f.writeMarker({ ...f.marker, withdrawn_release_commit: '0'.repeat(40) });
  await assert.rejects(verifyMarker(f.root, f.options()), /not an ancestor of HEAD/);

  f.writeMarker(f.marker);
  f.write('dist/protocol/3.2.0.tgz', 'recommitted\n');
  await assert.rejects(verifyMarker(f.root, f.options()), /present in the working tree/);
  fs.rmSync(path.join(f.root, 'dist/protocol/3.2.0.tgz'));

  f.write('dist/schemas/3.2.1/index.json', '{}\n');
  await assert.rejects(verifyMarker(f.root, f.options()), /Target 3\.2\.1 artifact/);
  fs.rmSync(path.join(f.root, 'dist/schemas'), { recursive: true });

  await assert.rejects(
    verifyMarker(f.root, f.options({ verifyNeverPublished: () => { throw new Error('Tag v3.2.0 exists'); } })),
    /Tag v3\.2\.0 exists/,
  );

  await assert.rejects(
    versionWithWithdrawnMarker(f.root, f.options({ runChangesetVersion: f.fakeChangesetVersion('3.3.0') })),
    /generated "3\.3\.0" instead of the withdrawn 3\.2\.0/,
  );
});

test('refuses a pre-exit cut that leaves archived changesets unconsumed', async (t) => {
  const f = fixture(t, { preMode: 'exit' });
  const { versionWithWithdrawnMarker } = await loadModule();
  await assert.rejects(
    versionWithWithdrawnMarker(f.root, f.options({
      runChangesetVersion: () => {
        fs.rmSync(path.join(f.root, '.changeset/pending-fix.md'));
        fs.rmSync(path.join(f.root, '.changeset/pre.json'));
        f.setVersion('3.2.0');
      },
    })),
    /complete pending and archived changeset pool/,
  );
  assert.equal(fs.existsSync(path.join(f.root, '.changeset/withdrawn-release.json')), true);
});

test('changelog rewrite refuses duplicate or pre-existing target blocks', async () => {
  const { skipChangelogContent } = await loadModule();
  const marker = { withdrawn_version: '3.2.0', target_version: '3.2.1', reason: REASON };
  assert.throws(() => skipChangelogContent('# Changelog\n\n## 3.2.0-rc.7\n', marker), /does not start with the generated 3\.2\.0/);
  assert.throws(() => skipChangelogContent('# Changelog\n\n## 3.2.0\n\n- a\n\n## 3.2.0\n', marker), /duplicate 3\.2\.0/);
  assert.throws(() => skipChangelogContent('# Changelog\n\n## 3.2.0\n\n- a\n\n## 3.2.1\n', marker), /already contains 3\.2\.1/);
});

test('release discovery keeps 3.2.0 non-selectable and lets 3.2.1 win', async () => {
  const { verifyNonSelectable } = await loadModule();
  await verifyNonSelectable(repositoryRoot, { withdrawn_version: '3.2.0', target_version: '3.2.1' });
  await assert.rejects(
    verifyNonSelectable(repositoryRoot, { withdrawn_version: '3.1.4', target_version: '3.1.5' }),
    /would let withdrawn 3\.1\.4 win a stable alias/,
  );
});

test('version wrapper routes through the withdrawn-release marker and selectable guard', () => {
  const wrapper = fs.readFileSync(path.join(repositoryRoot, 'scripts/version-packages.mjs'), 'utf8');
  assert.match(wrapper, /versionWithWithdrawnMarker/);
  assert.match(wrapper, /assertSelectableGeneratedVersion\(\);/);
});
