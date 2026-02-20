#!/usr/bin/env bash
# One-time fix for dist/docs/2.5.3: remaps v3-era building/ paths to their
# v2.5.3 equivalents in the protocols/ and reference/ directories.
set -euo pipefail

DOCS_DIR="dist/docs/2.5.3"

remap_file() {
  local file="$1"
  local tmp
  tmp=$(mktemp)
  sed \
    -e "s|/dist/docs/2\.5\.3/building/integration/authentication|/dist/docs/2.5.3/reference/authentication|g" \
    -e "s|/dist/docs/2\.5\.3/building/integration/context-sessions|/dist/docs/2.5.3/protocols/context-management|g" \
    -e "s|/dist/docs/2\.5\.3/building/integration/|/dist/docs/2.5.3/protocols/|g" \
    -e "s|/dist/docs/2\.5\.3/building/implementation/task-lifecycle\.mdx|/dist/docs/2.5.3/protocols/task-management.mdx|g" \
    -e "s|/dist/docs/2\.5\.3/building/implementation/task-lifecycle|/dist/docs/2.5.3/protocols/task-management|g" \
    -e "s|/dist/docs/2\.5\.3/building/implementation/error-handling|/dist/docs/2.5.3/protocols/error-handling|g" \
    -e "s|/dist/docs/2\.5\.3/building/understanding/|/dist/docs/2.5.3/protocols/|g" \
    -e "s|/dist/docs/2\.5\.3/building/)|/dist/docs/2.5.3/protocols/getting-started)|g" \
    -e "s|/dist/docs/2\.5\.3/building/\"|/dist/docs/2.5.3/protocols/getting-started\"|g" \
    -e "s|/dist/docs/2\.5\.3/building)|/dist/docs/2.5.3/protocols/getting-started)|g" \
    -e "s|/dist/docs/2\.5\.3/building\"|/dist/docs/2.5.3/protocols/getting-started\"|g" \
    "$file" > "$tmp"
  if ! diff -q "$file" "$tmp" > /dev/null 2>&1; then
    mv "$tmp" "$file"
    echo "changed: $file"
  else
    rm "$tmp"
  fi
}

export -f remap_file

while IFS= read -r -d '' file; do
  remap_file "$file"
done < <(find "$DOCS_DIR" -type f \( -name "*.md" -o -name "*.mdx" \) -print0)

echo "Done."
