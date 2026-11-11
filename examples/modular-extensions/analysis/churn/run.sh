#!/bin/sh
# Schema churn: classify every schema file change on the first-parent history, diff every GA
# release against the one before it, and aggregate the result under several placements.
# Usage:
#   analysis/churn/run.sh                                  full run: extract, releases, aggregate
#   analysis/churn/run.sh aggregate <placement.json> <out dir> [aggregate.py options]
# Environment:
#   REPO   git checkout of adcp (default: the repo this example lives in)
#   REF    last commit counted (default 45591e97b3)    SINCE  first day counted (default 2025-10-19)
# Needs ../schema-graph/raw/placement.json and ../kernel-cut/raw/ (analysis/run_all.sh builds both).
set -e
export PYTHONDONTWRITEBYTECODE=1
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
REPO=${REPO:-$(cd "$HERE/../../../.." && pwd)}
REF=${REF:-45591e97b3}
SINCE=${SINCE:-2025-10-19}
MILESTONES=${MILESTONES:-3.0=v3.0.0,3.1=v3.1.0,3.2=v3.2.1}
BASE=${BASE:-../schema-graph/raw/placement.json}
KC=${KC:-../kernel-cut/raw}

if [ "$1" = "aggregate" ]; then
  shift
  P=$1; O=$2; shift 2
  python3 -I aggregate.py --raw raw --placement "$P" --out "$O" "$@"
  exit 0
fi

UNTIL=$(git -C "$REPO" log -1 --format=%cI "$REF")
mkdir -p raw
python3 -I extract.py "$REPO" "$REF" "$SINCE" raw "$MILESTONES"
python3 -I releases.py "$REPO" "$SINCE" raw "$UNTIL"
python3 -I variants.py "$BASE" placements "$KC/placement2.json"
python3 -I aggregate.py --raw raw --placement "$BASE" --dag placements/cut-11-dag.json --out raw/agg-cut-11
python3 -I aggregate.py --raw raw --placement placements/merged-media-buy.json --out raw/agg-merged-media-buy
python3 -I aggregate.py --raw raw --placement placements/registries-assembled.json --out raw/agg-registries-assembled
KARGS="--layers $KC/layers.json --caps-owners $KC/caps2.json --dag $KC/dag2.json --dir-heuristic placements/cut-29-dir-heuristic.json"
python3 -I aggregate.py --raw raw --placement "$KC/placement2.json" $KARGS --out raw/agg-cut-29
python3 -I aggregate.py --raw raw --placement placements/cut-29-error-codes-registry.json $KARGS --out raw/agg-cut-29-error-codes-registry
