#!/usr/bin/env bash
# Rewrites unversioned links in a dist/docs/VERSION snapshot so all internal
# references point to that specific version rather than the live /docs/ tree.
#
# Usage: bash scripts/rewrite-dist-links.sh <version>
# Example: bash scripts/rewrite-dist-links.sh 3.0.0-beta.3

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver string" >&2
  exit 1
fi

MAJOR_VERSION="${VERSION%%.*}"

DOCS_DIR="dist/docs/$VERSION"
if [ ! -d "$DOCS_DIR" ]; then
  echo "Error: $DOCS_DIR does not exist" >&2
  exit 1
fi

echo "Rewriting links in $DOCS_DIR for version $VERSION"

# On macOS, sed -i requires an extension argument; on Linux it does not.
# Use a portable approach via a temp file.
#
# Rewrites two families of unpinned references to the exact version:
#   - /schemas/latest/  → /schemas/$VERSION/  (legacy; docs no longer use this)
#   - /schemas/vN/       → /schemas/$VERSION/  (current; docs source pins to major alias)
rewrite_file() {
  local file="$1"
  local tmp
  tmp=$(mktemp)

  sed \
    -e "s|](/docs/|](/dist/docs/$VERSION/|g" \
    -e "s|href=\"/docs/|href=\"/dist/docs/$VERSION/|g" \
    -e "s|\"\$schema\": \"/schemas/|\"\$schema\": \"/schemas/$VERSION/|g" \
    -e "s|https://adcontextprotocol.org/schemas/latest/|https://adcontextprotocol.org/schemas/$VERSION/|g" \
    -e "s|](/schemas/latest/|](/schemas/$VERSION/|g" \
    -e "s|\`/schemas/latest/|\`/schemas/$VERSION/|g" \
    -e "s|https://adcontextprotocol.org/schemas/v${MAJOR_VERSION}/|https://adcontextprotocol.org/schemas/$VERSION/|g" \
    -e "s|](/schemas/v${MAJOR_VERSION}/|](/schemas/$VERSION/|g" \
    -e "s|\`/schemas/v${MAJOR_VERSION}/|\`/schemas/$VERSION/|g" \
    `# ../../static/ → ../../../../static/: correct for one-level-deep source files` \
    `# (docs/contributing/ → dist/docs/VERSION/contributing/ adds 2 path segments).` \
    `# Files at other depths need separate rules.` \
    -e "s|](../../static/|](../../../../static/|g" \
    -e "s|href=\"../../static/|href=\"../../../../static/|g" \
    "$file" > "$tmp"

  if ! diff -q "$file" "$tmp" > /dev/null 2>&1; then
    mv "$tmp" "$file"
    echo "changed"
  else
    rm "$tmp"
    echo "unchanged"
  fi
}

export -f rewrite_file
export VERSION

CHANGED=0
while IFS= read -r -d '' file; do
  result=$(rewrite_file "$file")
  if [ "$result" = "changed" ]; then
    CHANGED=$((CHANGED + 1))
  fi
done < <(find "$DOCS_DIR" -type f \( -name "*.md" -o -name "*.mdx" \) -print0)

echo "Done. Rewrote links in $CHANGED file(s)."
