#!/bin/sh
# Experimental review: attribute every x-status marker to a feature id, find the stable files
# that host them inline, trace per-id churn, and the stable schemas each introducing change edited.
# Usage: analysis/experimental-review/run.sh <tree>   where <tree> holds static/schemas/source and
#        docs/reference/experimental-status.mdx at REF (analysis/run_all.sh exports it).
#   REPO  git checkout (default: the adcp repo this example lives in)   REF  default 45591e97b3
set -e
export PYTHONDONTWRITEBYTECODE=1
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${1:-$HERE/../../../..}
REPO=${REPO:-$(cd "$HERE/../../../.." && pwd)}
REF=${REF:-45591e97b3}
cd "$HERE"
python3 -I markers.py "$TREE/static/schemas/source" "$TREE/docs/reference/experimental-status.mdx"
python3 -I attribute.py > attribute.log
python3 -I hosts.py "$TREE/static/schemas/source" > hosts.log
python3 -I churn2.py "$REPO" "$REF" 2> churn2.log
python3 -I intro.py "$REPO" > intro.log
python3 -I summarize.py > summary.txt
