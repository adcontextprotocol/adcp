#!/usr/bin/env bash
# Keep the artifacts needed for ordinary development without materializing
# every historical documentation snapshot and release tarball.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

marker='# adcp sparse-dist-checkout'
patterns_file=$(git rev-parse --git-path info/sparse-checkout)
if [[ $(git config --bool --get core.sparseCheckout || true) == true ]] &&
   { [[ ! -f $patterns_file ]] || ! grep -Fxq "$marker" "$patterns_file"; }; then
  echo 'Existing sparse checkout is not managed by this script; refusing to replace it.' >&2
  exit 1
fi

case "${1:-}" in
  --full)
    git sparse-checkout disable
    echo 'Full checkout restored.'
    exit 0
    ;;
  '') ;;
  *) echo "Usage: $0 [--full]" >&2; exit 2 ;;
esac

patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
# The docs indexer requires one complete docs and schema snapshot for each
# version in navigation. Keep every schema and compliance release: build
# discovery and the canonical tests enumerate their complete release trees.
node - > "$patterns" <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const config = JSON.parse(fs.readFileSync('docs.json', 'utf8'));
const versions = config.navigation?.versions;
if (!Array.isArray(versions) || versions.length === 0) throw new Error('Missing docs navigation versions');
const snapshots = new Set();
function visit(value, found) {
  if (typeof value === 'string') {
    const match = value.match(/^dist\/docs\/([^/]+)\//);
    if (match) found.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) visit(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) visit(item, found);
  }
}
for (const version of versions) {
  const found = new Set();
  visit(version.groups, found);
  if (found.size !== 1) throw new Error(`Expected one docs snapshot for ${version.version}, found ${found.size}`);
  const [snapshot] = found;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(snapshot)) throw new Error(`Invalid snapshot version: ${snapshot}`);
  execFileSync('git', ['cat-file', '-e', `HEAD:dist/docs/${snapshot}`]);
  execFileSync('git', ['cat-file', '-e', `HEAD:dist/schemas/${snapshot}`]);
  snapshots.add(snapshot);
}
console.log('# adcp sparse-dist-checkout');
console.log('/*');
console.log('!/dist/docs/*');
for (const snapshot of [...snapshots].sort()) console.log(`/dist/docs/${snapshot}/`);
console.log('!/dist/protocol/');
NODE

git sparse-checkout set --no-cone --stdin < "$patterns"
echo 'Sparse dist checkout enabled. Re-run this script after documentation versions change.'
