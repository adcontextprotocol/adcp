const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, it } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/sign-protocol-tarball.sh');

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

function runSign(workspace) {
  return execFileSync('bash', ['scripts/sign-protocol-tarball.sh'], {
    cwd: workspace.dir,
    env: {
      ...process.env,
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
    const oldTarball = path.join(workspace.dir, 'dist/protocol/1.2.2.tgz');
    fs.writeFileSync(oldTarball, 'old-tarball');
    fs.writeFileSync(`${oldTarball}.sig`, 'old-signature');
    fs.writeFileSync(`${oldTarball}.crt`, 'old-certificate');

    const output = runSign(workspace);

    assert.match(output, /Skipping 1\.2\.2\.tgz \(not current package version 1\.2\.3\)/);
    assert.equal(fs.readFileSync(`${oldTarball}.sig`, 'utf8'), 'old-signature');
    assert.equal(fs.readFileSync(`${oldTarball}.crt`, 'utf8'), 'old-certificate');
  });
});
