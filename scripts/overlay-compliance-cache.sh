#!/usr/bin/env bash
# Mirror in-repo compliance source onto @adcp/sdk's bundled cache so the
# storyboard runner sees current-PR fixtures instead of the SDK-published
# snapshot. Used by both .github/workflows/training-agent-storyboards.yml
# and scripts/run-storyboards-matrix.sh — keep them calling the same
# script so local pre-push and CI grade against the same overlay.
#
# This is intentionally a mirror, not a copy-only overlay: stale files in
# the SDK cache would otherwise continue to run after a source storyboard is
# removed from static/compliance/source/. The generated index.json remains
# the SDK snapshot until SDK sync/publish; domains/ is regenerated locally
# from protocols/ as the legacy alias.

set -euo pipefail

SRC="${SRC:-static/compliance/source}"
# SDK 5.13 moved the cache dir from `latest` to the AdCP version string
# (e.g. `3.0.0`). 5.23.0 renamed the package `@adcp/client` -> `@adcp/sdk`
# and the compliance bundle moved with it. Resolve whichever subdir
# exists so the overlay doesn't have to bump with every SDK release.
CACHE_ROOT="node_modules/@adcp/sdk/compliance/cache"
# SDK 6.11+ ships a `<version>.previous` sibling alongside `<version>` for
# downgrade rollback. The runner reads from `<version>` (per ADCP_VERSION),
# so the overlay MUST target that one — `find ... | head -1` picked
# `.previous` non-deterministically on Linux ext4 in CI and left the live
# cache with the SDK-bundled YAML.
#
# Strategy: read the SDK's pinned version from `node_modules/@adcp/sdk/ADCP_VERSION`
# when present (canonical source of truth — the runner reads it the same way),
# else fall back to the first non-`.previous` cache subdir.
ADCP_VERSION_FILE="node_modules/@adcp/sdk/ADCP_VERSION"
if [ -f "$ADCP_VERSION_FILE" ]; then
  PINNED_VERSION=$(tr -d '[:space:]' < "$ADCP_VERSION_FILE")
  DST="$CACHE_ROOT/$PINNED_VERSION"
else
  # Sort so the canonical version comes before `.previous` (the dot makes
  # `.previous` lexicographically larger). Filter out `.previous` defensively.
  DST=$(find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | grep -v '\.previous$' \
    | sort \
    | head -1 || true)
fi

if [ -z "$DST" ] || [ ! -d "$DST" ]; then
  echo "warning: SDK compliance cache not found under $CACHE_ROOT — skipping overlay"
  exit 0
fi

echo "Mirroring $SRC onto $DST"
SOURCE_ENTRIES=(
  "protocols"
  "specialisms"
  "test-kits"
  "test-vectors"
  "universal"
)

for entry in "${SOURCE_ENTRIES[@]}"; do
  if [ ! -e "$SRC/$entry" ]; then
    continue
  fi
  rm -rf "$DST/$entry"
  mkdir -p "$DST"
  cp -R "$SRC/$entry" "$DST/$entry"
done

if [ -d "$DST/protocols" ]; then
  rm -rf "$DST/domains"
  cp -R "$DST/protocols" "$DST/domains"
fi

node - "$SRC" "$DST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { generateIndex } = require('./scripts/build-compliance.cjs');

const sourceDir = path.resolve(process.argv[2]);
const targetDir = path.resolve(process.argv[3]);
let version = path.basename(targetDir);
try {
  const prior = JSON.parse(fs.readFileSync(path.join(targetDir, 'index.json'), 'utf8'));
  version = prior.published_version || prior.adcp_version || version;
} catch {
  // Fall back to the target directory name when the SDK cache has no index yet.
}
const index = generateIndex(version, sourceDir);
fs.writeFileSync(path.join(targetDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
NODE

node scripts/lint-compliance-source-authority.cjs --source "$SRC" --target "$DST"
echo "Mirror complete."
