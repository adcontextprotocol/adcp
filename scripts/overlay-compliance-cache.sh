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
DST=$(find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)

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
