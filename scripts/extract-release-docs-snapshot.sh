#!/usr/bin/env bash
# Extracts the frozen documentation snapshot for a release into
# dist/docs/<version>/ from the release's own Git ref, never from the checkout.
#
# Usage: bash scripts/extract-release-docs-snapshot.sh <version> <source-ref>
# Example: bash scripts/extract-release-docs-snapshot.sh 3.2.4 v3.2.4
#
# The snapshot is exactly `git archive <source-ref> -- docs`. The release-docs
# workflow runs in a checkout of main, whose docs/ tree holds later (3.3)
# pages. Extracting over that tree used to leak every main-only page into the
# frozen snapshot, so a 3.2.4 snapshot carried pages the 3.2.4 tag never
# contained. This script extracts into an empty directory and fails closed if
# the result differs from the tag's file list.
#
# One deliberate exception: the stable 3.2 navigation lists a "3.3 preview"
# group (the whats-new, beta-program, and 3.2-to-3.3 migration pages), wired
# in by the 3.2.3 snapshot and its maintenance navigation sync. Those three
# pages are not in a 3.2.x tag, so a stable 3.2 snapshot carries them from the
# current checkout, with their development-only warnings, and only them. The
# list below is the whole exception; remove it together with that navigation
# group if the preview should leave the stable docs.

set -euo pipefail

VERSION="${1:-}"
SOURCE_REF="${2:-}"
if [ -z "$VERSION" ] || [ -z "$SOURCE_REF" ]; then
  echo "Usage: $0 <version> <source-ref>" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver string" >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "$SOURCE_REF^{commit}" > /dev/null; then
  echo "Error: source ref '$SOURCE_REF' does not resolve to a commit" >&2
  exit 1
fi

CARRIED_PAGES=()
if [[ "$VERSION" =~ ^3\.2\.[0-9]+$ ]]; then
  CARRIED_PAGES=(
    reference/whats-new-in-3-3.mdx
    reference/3-3-beta.mdx
    reference/migration/3-2-to-3-3.mdx
  )
fi

DEST="dist/docs/$VERSION"
SOURCE_DOCS="$(pwd)/docs"

# Remove existing version if present (allows re-running).
rm -rf "$DEST"
mkdir -p "$DEST"

git archive "$SOURCE_REF" -- docs | tar -x -C "$DEST" --strip-components=1

EXPECTED="$(mktemp)"
ACTUAL="$(mktemp)"
trap 'rm -f "$EXPECTED" "$ACTUAL"' EXIT

git -c core.quotepath=off ls-tree -r --name-only "$SOURCE_REF" -- docs | sed 's|^docs/||' | LC_ALL=C sort > "$EXPECTED"

for page in "${CARRIED_PAGES[@]+"${CARRIED_PAGES[@]}"}"; do
  if grep -qxF "$page" "$EXPECTED"; then
    continue
  fi
  if [ ! -f "$SOURCE_DOCS/$page" ]; then
    echo "Error: carried preview page docs/$page is not in $SOURCE_REF or the current checkout" >&2
    exit 1
  fi
  mkdir -p "$DEST/$(dirname "$page")"
  cp "$SOURCE_DOCS/$page" "$DEST/$page"
  echo "Carried main-only preview page docs/$page into $DEST (not in $SOURCE_REF)"
  echo "$page" >> "$EXPECTED"
done
LC_ALL=C sort -o "$EXPECTED" "$EXPECTED"

(cd "$DEST" && find . \( -type f -o -type l \) | sed 's|^\./||' | LC_ALL=C sort) > "$ACTUAL"

if ! diff -u "$EXPECTED" "$ACTUAL" > /dev/null; then
  echo "Error: $DEST does not match the file list of $SOURCE_REF:" >&2
  diff -u "$EXPECTED" "$ACTUAL" >&2 || true
  exit 1
fi

echo "Extracted $(wc -l < "$ACTUAL" | tr -d ' ') files from $SOURCE_REF into $DEST"
