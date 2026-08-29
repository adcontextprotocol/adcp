#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

source_commit="${ADCP_PROTOCOL_COMMIT_SHA:-$(git rev-parse HEAD)}"
head_commit="$(git rev-parse HEAD)"
if [[ "${source_commit}" != "${head_commit}" ]]; then
  echo "error: ADCP_PROTOCOL_COMMIT_SHA ${source_commit} does not match checked-out HEAD ${head_commit}" >&2
  exit 1
fi

dirty_inputs="$(git status --porcelain --untracked-files=all)"
if [[ -n "${dirty_inputs}" ]]; then
  echo "error: protocol bundle inputs must be committed before building provenance:" >&2
  echo "${dirty_inputs}" >&2
  exit 1
fi

source_date_epoch="$(git show -s --format=%ct HEAD)"
export SOURCE_DATE_EPOCH="${source_date_epoch}"
export ADCP_PROTOCOL_COMMIT_SHA="${source_commit}"

npm run build:schemas
npm run build:compliance
npm run build:protocol-tarball

(
  cd dist/protocol
  shasum -a 256 -c latest.tgz.sha256
)

node <<'NODE'
const provenance = require('./dist/protocol/latest.tgz.provenance.json');
if (provenance.source_commit !== process.env.ADCP_PROTOCOL_COMMIT_SHA) {
  throw new Error(`Bundle provenance ${provenance.source_commit} does not match ${process.env.ADCP_PROTOCOL_COMMIT_SHA}`);
}
console.log(`Protocol commit: ${provenance.source_commit}`);
console.log(`Bundle SHA-256: ${provenance.bundle_sha256}`);
NODE

echo "Bundle: ${repo_root}/dist/protocol/latest.tgz"
echo "Checksum: ${repo_root}/dist/protocol/latest.tgz.sha256"
echo "Provenance: ${repo_root}/dist/protocol/latest.tgz.provenance.json"
