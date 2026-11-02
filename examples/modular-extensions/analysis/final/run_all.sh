#!/bin/sh
# Final layout: placement, verification, churn re-aggregation, history metrics, and table data, into raw/.
# Usage: analysis/final/run_all.sh <schema source dir>
#   <schema source dir>  static/schemas/source of the tree at FINAL_REF (analysis/run_all.sh exports it)
#   FINAL_REF            the commit that tree comes from, recorded in raw/source.json
# Reads ../churn/raw/ (history at REF 45591e97b3; step 3 of analysis/run_all.sh writes it),
# ../module-cut/raw/sweeps.json, and the frozen inputs in inputs/.
# v2 (placement-final-v2.json) is the final layout: it keeps every wire payload byte-identical. v1
# (placement-final.json) is the placement v2 starts from. v2 outputs carry a -v2 suffix.
set -e
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")"
SRC=${1:?usage: final/run_all.sh <schema source dir>}
mkdir -p raw
python3 -I -B edges_final.py "$SRC"
python3 -I -B place_final.py > raw/place_final.log
python3 -I -B place_final_v2.py > raw/place_final_v2.log
python3 -I -B verify_final.py > raw/verify_final.log
FINAL_TAG=v2 python3 -I -B verify_final.py > raw/verify_final_v2.log
python3 -I -B inputs_final.py > /dev/null

agg() {  # <name> <placement>
  python3 -I -B ../churn/aggregate.py --raw ../churn/raw --placement "$2" --layers raw/layers-final.json \
    --caps-owners raw/caps-final.json --dag raw/dag-final.json --dir-heuristic raw/dir-heuristic-final.json \
    --out "raw/agg-$1" > /dev/null
  python3 -I -B metrics_final.py "$1" "raw/agg-$1" > /dev/null
}
agg final raw/placement-final.json
agg variant-catalogs-module raw/placement-variant-catalogs-module.json
agg variant-bridge-in-modules raw/placement-variant-bridge-in-modules.json
agg final-v2 raw/placement-final-v2.json
python3 -I -B report_final.py > /dev/null
FINAL_TAG=v2 python3 -I -B report_final.py > /dev/null
echo "done: raw/placement-final-v2.json, raw/verify-final-v2.json, raw/metrics-final-v2.json, raw/tables-final-v2.json"
