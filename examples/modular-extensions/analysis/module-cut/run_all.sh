#!/bin/sh
# Co-change module cut: rebuild the co-change matrix, the candidate cuts, their aggregations,
# and the metrics, into raw/. Reads ../churn/raw/ and ../kernel-cut/raw/ (run those first, or
# use analysis/run_all.sh). N sets the sweep threshold; CUTS runs a subset of cuts.
set -e
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")"
mkdir -p raw
N=${N:-8}
python3 -I cochange.py "$N"
CH=../churn
KC=../kernel-cut/raw
# baselines, same sweep list: cut-11 (the first 11-module placement) and cut-29 (the kernel cut)
python3 -I $CH/aggregate.py --raw $CH/raw --placement ../schema-graph/raw/placement.json --dag $CH/placements/cut-11-dag.json --out raw/agg-cut-11 >/dev/null
python3 -I metrics.py cut-11 raw/agg-cut-11 specs/groups-cut-11.json --dag $CH/placements/cut-11-dag.json
python3 -I $CH/aggregate.py --raw $CH/raw --placement $KC/placement2.json --layers $KC/layers.json \
  --caps-owners $KC/caps2.json --dag $KC/dag2.json --dir-heuristic $CH/placements/cut-29-dir-heuristic.json --out raw/agg-cut-29 >/dev/null
python3 -I metrics.py cut-29 raw/agg-cut-29 specs/groups-cut-29.json --layers $KC/layers.json --dag $KC/dag2.json
for CUT in ${CUTS:-coarse balanced balanced-vocab buying-core buying-delivery indicators-kernel proposals-split formats-split}; do
  python3 -I build_cut.py specs/$CUT.json raw/$CUT
  python3 -I $CH/aggregate.py --raw $CH/raw --placement raw/$CUT/placement.json --layers raw/$CUT/layers.json \
    --caps-owners raw/$CUT/caps.json --dag raw/$CUT/dag.json --dir-heuristic raw/$CUT/dir-heuristic.json \
    --out raw/agg-$CUT >/dev/null
  python3 -I metrics.py $CUT raw/agg-$CUT specs/groups-$CUT.json --layers raw/$CUT/layers.json --dag raw/$CUT/dag.json
done
python3 -I couplings.py buying-delivery 10 >/dev/null
python3 -I affinity.py buying-delivery 3 >/dev/null
python3 -I compare.py cut-11 cut-29 coarse balanced buying-core buying-delivery
