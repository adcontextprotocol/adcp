#!/bin/sh
# Reproduce the proposal's history-based numbers from this repo's own git history.
# Usage, from the adcp repo root:  examples/modular-extensions/analysis/run_all.sh
#   REPO   git checkout to read (default: the repo this example lives in)
#   REF    pinned commit (default 45591e97b3)    SINCE  first day counted (default 2025-10-19)
#   FINAL_REF  the tree the final layout places (default ad1f380f8c); its history still comes from REF
# Needs python3 (stdlib only) and git with the v2.x and v3.x release tags (git fetch --tags).
set -e
export PYTHONDONTWRITEBYTECODE=1
HERE=$(cd "$(dirname "$0")" && pwd)
export REPO=${REPO:-$(cd "$HERE/../../.." && pwd)}
export REF=${REF:-45591e97b3}
export SINCE=${SINCE:-2025-10-19}
export FINAL_REF=${FINAL_REF:-ad1f380f8c}
git -C "$REPO" cat-file -e "$REF^{commit}" || { echo "REF $REF is not in $REPO; run git fetch origin" >&2; exit 1; }
git -C "$REPO" cat-file -e "$FINAL_REF^{commit}" || { echo "FINAL_REF $FINAL_REF is not in $REPO; run git fetch origin" >&2; exit 1; }

# The tree at REF: schemas, the experimental registry, and the paths place2.py searches for names.
TREE=$(mktemp -d)
FINAL_TREE=$(mktemp -d)
trap 'rm -rf "$TREE" "$FINAL_TREE"' EXIT
git -C "$REPO" archive "$REF" static/schemas/source docs server static/compliance scripts tests | tar -x -C "$TREE"
git -C "$REPO" archive "$FINAL_REF" static/schemas/source | tar -x -C "$FINAL_TREE"
SRC=$TREE/static/schemas/source
mkdir -p "$HERE/schema-graph/raw" "$HERE/kernel-cut/raw" "$HERE/churn/raw" "$HERE/module-cut/raw" "$HERE/final/raw"

step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$1"; }
step "schema graph and first placement";  "$HERE/schema-graph/run_all.sh" "$SRC" > "$HERE/schema-graph/raw/run.log"
step "kernel cut";                         "$HERE/kernel-cut/run_all.sh" "$SRC" > "$HERE/kernel-cut/raw/run.log"
step "churn (history since $SINCE to $REF)"; "$HERE/churn/run.sh" > "$HERE/churn/raw/run.log"
step "module cut";                         "$HERE/module-cut/run_all.sh" > "$HERE/module-cut/raw/run.log"
step "experimental review";                "$HERE/experimental-review/run.sh" "$TREE"
step "final layout (tree at $FINAL_REF)";  "$HERE/final/run_all.sh" "$FINAL_TREE/static/schemas/source" > "$HERE/final/raw/run.log"
step "done; see analysis/README.md for where each number lands"
