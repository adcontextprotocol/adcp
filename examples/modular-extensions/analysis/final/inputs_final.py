"""Final layout step 4: inputs for churn/aggregate.py, plus two sensitivity placements.

Usage: python3 -I -B inputs_final.py
Reads raw/placement-final.json, inputs/buying-layers-{caps,dir-heuristic}.json, inputs/star-placement.json.
Writes raw/layers-final.json, raw/caps-final.json, raw/dag-final.json, raw/dir-heuristic-final.json, and
       raw/placement-variant-catalogs-module.json   catalogs as its own module (the buying-layers choice)
       raw/placement-variant-bridge-in-modules.json bridge-only files left in their star-analysis module
Capability owners come from the buying-layers analysis, with the three media-vocabulary paths left over from
the star analysis given to buying layers.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common_final import BRIDGE_ENDS, BRIDGE_NAMES, DEPS, INPUTS, ORDER, RAW, dump, load  # noqa: E402

place = load(os.path.join(RAW, "placement-final.json"))
labels = sorted({v["label"] for v in place.values()} | {"module:catalogs"})


def kind(l):
    if l in ("kernel", "kernel-types"):
        return "kernel"
    if l.startswith("module:"):
        return "module"
    if l.startswith("extension:"):
        return "extension"
    return l


dump({l: kind(l) for l in labels}, os.path.join(RAW, "layers-final.json"))

caps = load(os.path.join(INPUTS, "buying-layers-caps.json"))
owners = caps["owners"]
mv = owners.pop("module:media-vocabulary")["paths"]
CAPS_MV = {"media_buy.acceptance_policy_discovery": "module:buying/supply",  # acceptance-policy files: supply
           "media_buy.supported_optimization_metrics": "module:buying/commitment",  # optimization-goal: commitment
           "media_buy.vendor_metric_optimization": "module:buying/supply"}  # vendor-metric-optimization: supply
assert set(mv) == set(CAPS_MV), mv
for p, o in CAPS_MV.items():
    owners.setdefault(o, {"paths": []})["paths"].append(p)
dump({"owners": owners}, os.path.join(RAW, "caps-final.json"))

dag = {l: [] for l in labels if l.startswith("module:") and "/" not in l}
for l in ORDER:
    dag[f"module:buying/{l}"] = [f"module:buying/{x}" for x in DEPS[l]]
dag["kernel"] = []
dag["kernel-types"] = ["kernel"]
for bid, name in BRIDGE_NAMES.items():
    declaring, other = BRIDGE_ENDS[bid]
    dag[f"extension:{name}"] = sorted(f"module:{m}" for m in declaring | {other} if m != "buying")
dump(dag, os.path.join(RAW, "dag-final.json"))

dh = load(os.path.join(INPUTS, "buying-layers-dir-heuristic.json"))
dh = [[p, "module:buying/catalogs" if m == "module:catalogs" else m] for p, m in dh]
dump(dh, os.path.join(RAW, "dir-heuristic-final.json"))

var = {f: dict(v, label=("module:catalogs" if v["label"] == "module:buying/catalogs" else v["label"]))
       for f, v in place.items()}
dump(var, os.path.join(RAW, "placement-variant-catalogs-module.json"))
star = load(os.path.join(INPUTS, "star-placement.json"))
var = {f: (dict(v, label=star[f]["label"]) if v["reason"].startswith("F-bridge-only") else v)
       for f, v in place.items()}
dump(var, os.path.join(RAW, "placement-variant-bridge-in-modules.json"))
print("inputs written:", len(labels), "labels;", len(owners), "caps owners")
