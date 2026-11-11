#!/bin/sh
# Kernel cut: placement, layers, module DAG, capability owners, kernel churn, and the layering
# lint, regenerated into raw/.
# Usage: analysis/kernel-cut/run_all.sh [<static/schemas/source dir>]
#   REPO  git checkout for the kernel-churn history (default: the adcp repo this example lives in)
#   REF   last commit counted (default 45591e97b3)    SINCE  first day counted (default 2025-10-19)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$HERE/../../../../static/schemas/source}
REPO=${REPO:-$(cd "$HERE/../../../.." && pwd)}
REF=${REF:-45591e97b3}
SINCE=${SINCE:-2025-10-19}
cd "$HERE"
mkdir -p raw
python3 -I ../schema-graph/build_graph.py "$SRC" raw
python3 -I ../schema-graph/analyze_experimental.py "$SRC" raw > raw/experimental.log
python3 -I place2.py "$SRC" raw > raw/place2.log
python3 -I caps2.py "$SRC" raw > raw/caps2.log
python3 -I kernel_churn.py "$REPO" raw "$SINCE" "$REF" > raw/kernel_churn.log
python3 -I lint_cut.py "$SRC" raw
