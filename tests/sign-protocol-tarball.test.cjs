const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/sign-protocol-tarball.sh');
const {
  buildTarball,
  pinGeneratedAt,
  pinPublishedVersion,
  resolveBuildMetadata,
  writeIntegritySidecars,
} = require('../scripts/build-protocol-tarball.cjs');

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeWorkspace(version = '1.2.3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-protocol-tarball-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist/protocol'), { recursive: true });
  fs.cpSync(SCRIPT, path.join(dir, 'scripts/sign-protocol-tarball.sh'));
  fs.chmodSync(path.join(dir, 'scripts/sign-protocol-tarball.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));

  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'cosign'), `#!/usr/bin/env bash
set -euo pipefail
sig=""
crt=""
input=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-signature) sig="$2"; shift 2 ;;
    --output-certificate) crt="$2"; shift 2 ;;
    --yes) shift ;;
    sign-blob) shift ;;
    *) input="$1"; shift ;;
  esac
done
body="$(cat "$input")"
printf 'sig:%s' "$body" > "$sig"
printf -- '-----BEGIN CERTIFICATE-----\\ncrt:%s\\n' "$body" > "$crt"
`);
  fs.chmodSync(path.join(binDir, 'cosign'), 0o755);

  return { dir, binDir };
}

function runSign(workspace, extraEnv = {}) {
  return execFileSync('bash', ['scripts/sign-protocol-tarball.sh'], {
    cwd: workspace.dir,
    env: {
      ...process.env,
      ...extraEnv,
      GITHUB_ACTIONS: 'true',
      PATH: `${workspace.binDir}${path.delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8',
  });
}

function runSignResult(workspace, extraEnv = {}) {
  return spawnSync('bash', ['scripts/sign-protocol-tarball.sh'], {
    cwd: workspace.dir,
    env: {
      ...process.env,
      ...extraEnv,
      GITHUB_ACTIONS: 'true',
      PATH: `${workspace.binDir}${path.delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8',
  });
}

describe('sign-protocol-tarball.sh', () => {
  it('replaces sidecars for the current package version on rerun', () => {
    const workspace = makeWorkspace('1.2.3');
    const tarball = path.join(workspace.dir, 'dist/protocol/1.2.3.tgz');
    fs.writeFileSync(tarball, 'rebuilt-tarball');
    fs.writeFileSync(`${tarball}.sig`, 'stale-signature');
    fs.writeFileSync(`${tarball}.crt`, 'stale-certificate');

    const output = runSign(workspace);

    assert.match(output, /Replacing signature sidecars for current package version 1\.2\.3/);
    assert.equal(fs.readFileSync(`${tarball}.sig`, 'utf8'), 'sig:rebuilt-tarball');
    assert.match(fs.readFileSync(`${tarball}.crt`, 'utf8'), /^-----BEGIN CERTIFICATE-----\ncrt:rebuilt-tarball\n/);
  });

  it('does not rewrite already signed older tarballs by default', () => {
    const workspace = makeWorkspace('1.2.3');
    fs.writeFileSync(path.join(workspace.dir, 'dist/protocol/1.2.3.tgz'), 'current-tarball');
    const oldTarball = path.join(workspace.dir, 'dist/protocol/1.2.2.tgz');
    fs.writeFileSync(oldTarball, 'old-tarball');
    fs.writeFileSync(`${oldTarball}.sig`, 'old-signature');
    fs.writeFileSync(`${oldTarball}.crt`, 'old-certificate');

    const output = runSign(workspace);

    assert.match(output, /Skipping 1\.2\.2\.tgz \(not current package version 1\.2\.3\)/);
    assert.equal(fs.readFileSync(`${oldTarball}.sig`, 'utf8'), 'old-signature');
    assert.equal(fs.readFileSync(`${oldTarball}.crt`, 'utf8'), 'old-certificate');
  });

  it('fails closed when the expected current tarball is missing', () => {
    const workspace = makeWorkspace('1.2.3');
    const oldTarball = path.join(workspace.dir, 'dist/protocol/1.2.2.tgz');
    fs.writeFileSync(oldTarball, 'old-tarball');
    fs.writeFileSync(`${oldTarball}.sig`, 'old-signature');
    fs.writeFileSync(`${oldTarball}.crt`, 'old-certificate');

    const result = runSignResult(workspace);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected current protocol tarball .*1\.2\.3\.tgz was not found/);
    assert.equal(fs.readFileSync(`${oldTarball}.sig`, 'utf8'), 'old-signature');
    assert.equal(fs.readFileSync(`${oldTarball}.crt`, 'utf8'), 'old-certificate');
  });

  it('fails closed when package.json has no version', () => {
    const workspace = makeWorkspace('1.2.3');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(workspace.dir, 'dist/protocol/1.2.3.tgz'), 'tarball');

    const result = runSignResult(workspace);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not resolve package\.json version/);
  });

  it('refuses a partial historical sidecar set in explicit sign-all mode', () => {
    const workspace = makeWorkspace('1.2.3');
    const oldTarball = path.join(workspace.dir, 'dist/protocol/1.2.2.tgz');
    fs.writeFileSync(oldTarball, 'old-tarball');
    fs.writeFileSync(`${oldTarball}.sig`, 'old-signature');

    const result = runSignResult(workspace, { SIGN_ALL_PROTOCOL_TARBALLS: 'true' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite partial signature sidecars/);
    assert.equal(fs.readFileSync(`${oldTarball}.sig`, 'utf8'), 'old-signature');
    assert.equal(fs.existsSync(`${oldTarball}.crt`), false);
  });

  it('preserves complete historical sidecars in explicit sign-all mode', () => {
    const workspace = makeWorkspace('1.2.3');
    const oldTarball = path.join(workspace.dir, 'dist/protocol/1.2.2.tgz');
    fs.writeFileSync(oldTarball, 'old-tarball');
    fs.writeFileSync(`${oldTarball}.sig`, 'old-signature');
    fs.writeFileSync(`${oldTarball}.crt`, 'old-certificate');

    const output = runSign(workspace, { SIGN_ALL_PROTOCOL_TARBALLS: 'true' });

    assert.match(output, /Skipping 1\.2\.2\.tgz \(signature sidecars already exist\)/);
    assert.equal(fs.readFileSync(`${oldTarball}.sig`, 'utf8'), 'old-signature');
    assert.equal(fs.readFileSync(`${oldTarball}.crt`, 'utf8'), 'old-certificate');
  });
});

describe('build-protocol-tarball.cjs', () => {
  it('uses SOURCE_DATE_EPOCH and protocol commit for stable metadata', () => {
    const metadata = resolveBuildMetadata({
      SOURCE_DATE_EPOCH: '1787979011',
      ADCP_PROTOCOL_COMMIT_SHA: 'e0567393bb3ae3d955532b99949ba1dfc3b4a40f',
    });

    assert.equal(metadata.generatedAt, '2026-08-29T04:50:11.000Z');
    assert.equal(metadata.archiveMtime.toISOString(), metadata.generatedAt);
    assert.equal(metadata.sourceRepository, 'adcontextprotocol/adcp');
    assert.equal(metadata.sourceCommit, 'e0567393bb3ae3d955532b99949ba1dfc3b4a40f');
  });

  it('fails closed on invalid reproducible-build inputs', () => {
    assert.throws(
      () => resolveBuildMetadata({ SOURCE_DATE_EPOCH: 'yesterday' }),
      /SOURCE_DATE_EPOCH must be an integer/,
    );
    assert.throws(
      () => resolveBuildMetadata({ ADCP_PROTOCOL_COMMIT_SHA: 'e0567393bb' }),
      /40-character Git commit SHA/,
    );
  });

  it('creates reproducible tarball and provenance bytes', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-protocol-tarball-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const staging = path.join(tmp, 'staging');
    const bundleRoot = path.join(staging, 'adcp-latest');
    fs.mkdirSync(path.join(bundleRoot, 'schemas'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'README.md'), 'bundle\n');
    fs.writeFileSync(path.join(bundleRoot, 'schemas', 'index.json'), '{"adcp_version":"latest"}\n');

    const metadata = resolveBuildMetadata({
      SOURCE_DATE_EPOCH: '1787979011',
      ADCP_PROTOCOL_COMMIT_SHA: 'e0567393bb3ae3d955532b99949ba1dfc3b4a40f',
    });
    const first = path.join(tmp, 'first.tgz');
    const second = path.join(tmp, 'second.tgz');

    await buildTarball('first', staging, 'adcp-latest', first, metadata);
    fs.utimesSync(path.join(bundleRoot, 'README.md'), new Date(), new Date());
    await buildTarball('second', staging, 'adcp-latest', second, metadata);

    assert.equal(digest(first), digest(second));

    writeIntegritySidecars(first, metadata, '3.2.0-beta.9');
    const provenance = JSON.parse(fs.readFileSync(`${first}.provenance.json`, 'utf8'));
    assert.equal(provenance.source_commit, metadata.sourceCommit);
    assert.equal(provenance.bundle_sha256, digest(first));
    assert.equal(fs.readFileSync(`${first}.sha256`, 'utf8'), `${digest(first)}  first.tgz\n`);

    writeIntegritySidecars(first, resolveBuildMetadata({}, new Date(0)), '3.2.0-beta.9');
    assert.equal(fs.existsSync(`${first}.provenance.json`), false);
  });

  it('pins generated timestamps without changing unrelated metadata', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-protocol-manifest-'));
    const manifestPath = path.join(tmp, 'manifest.json');
    try {
      fs.writeFileSync(manifestPath, JSON.stringify({ generated_at: 'now', value: 42 }));
      pinGeneratedAt(manifestPath, '2026-08-29T04:50:11.000Z');
      assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
        generated_at: '2026-08-29T04:50:11.000Z',
        value: 42,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses the package semver expected by SDK sync in PR bundle indexes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-protocol-index-'));
    const indexPath = path.join(tmp, 'index.json');
    try {
      fs.writeFileSync(indexPath, JSON.stringify({
        published_version: 'latest',
        adcp_version: 'latest',
        baseUrl: '/schemas/latest',
        schemas: {},
      }));
      pinPublishedVersion(indexPath, '3.2.0-beta.9');
      assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, 'utf8')), {
        published_version: '3.2.0-beta.9',
        adcp_version: '3.2.0-beta.9',
        baseUrl: '/schemas/3.2.0-beta.9',
        schemas: {},
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
