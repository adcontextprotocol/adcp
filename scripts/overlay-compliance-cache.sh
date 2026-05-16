#!/usr/bin/env bash
# Overlay in-repo compliance source onto @adcp/sdk's bundled cache so the
# storyboard runner sees current-PR fixtures instead of the SDK-published
# snapshot. Used by both .github/workflows/training-agent-storyboards.yml
# and scripts/run-storyboards-matrix.sh — keep them calling the same
# script so local pre-push and CI grade against the same overlay.
#
# Caveat: this overlay does NOT regenerate the SDK's cache index (e.g.,
# index.json bundles enumerated at build time). New files under existing
# protocols are picked up via directory walk, but adding a brand-new
# top-level bundle (a new specialism / universal file) may need a
# sync-schemas cycle on the SDK side before the runner enumerates it.
# New files under existing scenarios/ dirs are the common case and
# work fine.

set -uo pipefail

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
    | head -1)
fi

if [ -z "$DST" ] || [ ! -d "$DST" ]; then
  echo "warning: SDK compliance cache not found under $CACHE_ROOT — skipping overlay"
  exit 0
fi

echo "Overlaying $SRC onto $DST"
(cd "$SRC" && find . -type f) | while read -r rel; do
  target="$DST/${rel#./}"
  mkdir -p "$(dirname "$target")"
  cp "$SRC/${rel#./}" "$target"
done
echo "Overlay complete."
