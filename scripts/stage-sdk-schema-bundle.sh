#!/usr/bin/env bash
# Stage a repo schema bundle into @adcp/sdk's built schemas-data directory.
#
# The SDK validates per-instance adcpVersion pins against
# node_modules/@adcp/sdk/dist/lib/schemas-data/<bundle-key>. Some prerelease
# SDK builds intentionally ship only the current prerelease schema bundle, but
# this repo's 3.0 compatibility storyboard lane still runs against the latest
# archived 3.0.x compliance bundle. This script lets CI/local compat runs copy
# the matching archived dist/schemas/<version> tree into node_modules at run
# time without committing generated dist output.

set -euo pipefail

SRC="${1:-${ADCP_SCHEMA_DIR:-}}"
VERSION="${2:-}"

if [ -z "$SRC" ]; then
  echo "::error::schema source directory required"
  echo "usage: scripts/stage-sdk-schema-bundle.sh <dist/schemas/version> [version]"
  exit 1
fi

if [ ! -f "$SRC/index.json" ]; then
  echo "::error::Schema bundle not found at $SRC"
  exit 1
fi

if [ -z "$VERSION" ]; then
  VERSION=$(node - <<'NODE' "$SRC/index.json"
const fs = require('node:fs');
const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(index.version || index.adcp_version || '');
NODE
)
fi

if [ -z "$VERSION" ]; then
  echo "::error::Could not determine schema bundle version from $SRC/index.json"
  exit 1
fi

BUNDLE_KEY=$(node - <<'NODE' "$VERSION"
const version = process.argv[2];
const semver = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
if (semver) {
  const [, major, minor, , prerelease] = semver;
  process.stdout.write(prerelease === undefined ? `${major}.${minor}` : version);
  process.exit(0);
}
const minor = version.match(/^(\d+)\.(\d+)$/);
if (minor) {
  process.stdout.write(`${minor[1]}.${minor[2]}`);
  process.exit(0);
}
process.exit(2);
NODE
)

case "$BUNDLE_KEY" in
  [0-9]*.[0-9]*|[0-9]*.[0-9]*.[0-9]*-*)
    ;;
  *)
    echo "::error::Refusing unexpected schema bundle key: $BUNDLE_KEY"
    exit 1
    ;;
esac

DST_ROOT="node_modules/@adcp/sdk/dist/lib/schemas-data"
DST="$DST_ROOT/$BUNDLE_KEY"

if [ ! -d "$DST_ROOT" ]; then
  echo "::error::SDK schemas-data directory not found at $DST_ROOT"
  exit 1
fi

echo "Staging schema bundle $VERSION as SDK bundle key $BUNDLE_KEY"
rm -rf "$DST"
mkdir -p "$DST"
(cd "$SRC" && tar -cf - .) | (cd "$DST" && tar -xf -)

echo "Schema bundle staged at $DST"
