#!/bin/sh
# Schema graph and the first placement: regenerate raw/ from a schema tree.
# Usage: analysis/schema-graph/run_all.sh [<static/schemas/source dir>]
# The default is the working tree of the adcp repo this example lives in. analysis/run_all.sh
# passes the tree at the pinned REF instead.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$HERE/../../../../static/schemas/source}
cd "$HERE"
mkdir -p raw
python3 -I build_graph.py "$SRC" raw
python3 -I analyze_dirs.py raw
python3 -I analyze_experimental.py "$SRC" raw
python3 -I place.py raw
python3 -I caps.py "$SRC" raw
