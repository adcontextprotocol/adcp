#!/bin/bash
#
# Sync v2.6-rc docs from 2.6.x branch for local testing
#
# Usage:
#   ./scripts/sync-versioned-docs.sh           # Sync from remote 2.6.x branch
#   ./scripts/sync-versioned-docs.sh --local   # Sync from local 2.6.x branch (if checked out)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "🔄 Syncing v2.6-rc docs from 2.6.x branch..."

# Check if --local flag is passed
if [[ "$1" == "--local" ]]; then
    # Check if 2.6.x branch exists locally
    if ! git show-ref --verify --quiet refs/heads/2.6.x; then
        echo "❌ Local branch 2.6.x not found. Fetch it first or use remote sync."
        exit 1
    fi
    SOURCE_REF="2.6.x"
    echo "📂 Using local 2.6.x branch"
else
    # Fetch latest from remote
    echo "📡 Fetching latest 2.6.x from remote..."
    git fetch origin 2.6.x
    SOURCE_REF="origin/2.6.x"
    echo "📂 Using remote origin/2.6.x branch"
fi

# Remove existing v2.6-rc/docs
rm -rf v2.6-rc/docs
mkdir -p v2.6-rc

# Extract docs from 2.6.x branch
echo "📦 Extracting docs folder..."
git archive "$SOURCE_REF" -- docs | tar -x -C v2.6-rc/

# Count files synced
FILE_COUNT=$(find v2.6-rc/docs -type f | wc -l | tr -d ' ')

echo ""
echo "✅ Synced $FILE_COUNT files to v2.6-rc/docs/"
echo ""
echo "To test locally with Mintlify:"
echo "  npx mintlify dev"
echo ""
echo "⚠️  Note: v2.6-rc/ is tracked in git. Don't commit local changes"
echo "    unless you want to override the automated sync."

