"""Final layout step 5: history metrics for one aggregation of the churn data.

Usage: python3 -I -B metrics_final.py <name> <agg dir>
Reads <agg dir>/{summary.json,commit_modules.csv,release_modules.csv} (churn/aggregate.py output, churn/raw at
REF 45591e97b3), module-cut/raw/sweeps.json (the fixed sweep list, N = 8), and
inputs/buying-layers-classification.csv (commit verdicts). Writes raw/metrics-<name>.json.

Definitions
  post-GA          windows 3.0->3.1, 3.1->3.2, 3.2->now
  kernel share     kernel-layer file changes / all file changes (and the same for non-additive changes)
  unit             a standard module, the compliance-testing leaf, catalogs if separate, or an extension;
                   buying's layers count as one unit; kernel, assembly, and retired files are not units
  cross-module     a substantive commit (capabilities split by owner) that touches 2 or more units
  buying commit    a substantive commit that touches a buying layer file or a buying capability block
  implementer      GA releases (of 65) that touch the implementer's module or the kernel layer
  layer implementer GA releases that touch the layer, the layers below it (DEPS), or the kernel layer
"""
import csv
import itertools
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common_final import DEPS, INPUTS, MODULE_CUT, ORDER, RAW, dump, load  # noqa: E402

name, agg = sys.argv[1], sys.argv[2]
S = load(os.path.join(agg, "summary.json"))
sweeps = {s["sha"][:10] for s in load(os.path.join(MODULE_CUT, "raw", "sweeps.json"))["commits"]}
POST = ["3.0->3.1", "3.1->3.2", "3.2->now"]
blw = S["by_layer_window"]
fc = sum(blw[f"total|{w}"]["file_changes"] for w in POST)
fcn = sum(blw[f"total|{w}"]["fc_nonadditive"] for w in POST)
kfc = sum(blw.get(f"kernel|{w}", {}).get("file_changes", 0) for w in POST)
kfcn = sum(blw.get(f"kernel|{w}", {}).get("fc_nonadditive", 0) for w in POST)


def is_unit(m):
    return m.startswith("module:") or m.startswith("extension:") or m.startswith("x-")


def unit(m):
    return "module:buying" if m.startswith("module:buying/") else m


def units(r, drop=()):
    return {unit(m) for m in r["modules"].split() if is_unit(m) and unit(m) not in drop}


rows = list(csv.DictReader(open(os.path.join(agg, "commit_modules.csv"))))
post = [r for r in rows if r["window"] in POST]
post_ns = [r for r in post if r["sha"] not in sweeps]


def share(sel, drop=(), k=2):
    n = len(sel)
    x = sum(1 for r in sel if len(units(r, drop)) >= k)
    return {"commits": n, "cross": x, "pct": round(100 * x / n, 1) if n else None}


CT = ("module:compliance-testing",)
EXT = tuple(sorted({m for r in rows for m in r["modules"].split() if m.startswith("extension:")}))
out = {"name": name,
       "kernel_share_post_ga_fc": [kfc, fc, round(100 * kfc / fc, 1)],
       "kernel_share_post_ga_nonadd_fc": [kfcn, fcn, round(100 * kfcn / fcn, 1)],
       "cross_post_no_sweeps": share(post_ns),
       "cross_post_no_sweeps_no_ct": share(post_ns, CT),
       "cross_post_no_sweeps_modules_only": share(post_ns, EXT),
       "cross_post_with_sweeps": share(post),
       "cross_all_no_sweeps": share([r for r in rows if r["sha"] not in sweeps]),
       "five_plus_post_no_sweeps": share(post_ns, k=5)["cross"]}
pairs = Counter()
for r in post_ns:
    for x, y in itertools.combinations(sorted(units(r)), 2):
        pairs[(x, y)] += 1
out["top_pairs_post_no_sweeps"] = [[x, y, n] for (x, y), n in pairs.most_common(12)]

# ---------------------------------------------------------------- buying layers
layer_names = [l for l in ORDER]


def layers(r):
    return {m.split("/", 1)[1] for m in r["modules"].split() if m.startswith("module:buying/")}


bsel = [r for r in post_ns if layers(r)]
one = [r for r in bsel if len(layers(r)) == 1]
lp = Counter()
for r in bsel:
    for x, y in itertools.combinations(sorted(layers(r), key=ORDER.index), 2):
        lp[(x, y)] += 1
per_layer = Counter(l for r in bsel for l in layers(r))
alone = Counter(next(iter(layers(r))) for r in one)
out["buying_layers"] = {
    "buying_commits_post_no_sweeps": len(bsel), "single_layer": len(one),
    "single_layer_pct": round(100 * len(one) / len(bsel), 1) if bsel else None,
    "three_plus_layers": sum(1 for r in bsel if len(layers(r)) >= 3),
    "per_layer": {l: [per_layer[l], alone[l]] for l in layer_names if per_layer[l] or alone[l]},
    "top_layer_pairs": [[x, y, n] for (x, y), n in lp.most_common(10)],
    "buying_commits_all_no_sweeps": sum(1 for r in rows if r["sha"] not in sweeps and layers(r)),
    "single_layer_all_no_sweeps": sum(1 for r in rows if r["sha"] not in sweeps and len(layers(r)) == 1)}
# Projection (inference): the buying-layers analysis read every post-GA cross-layer buying commit of its 343
# files (inputs/buying-layers-classification.csv); verdict L means the named fix keeps the commit in one layer
# or moves it out of buying. Count those as single-layer.
# The 53 files the star analysis moved into buying make more commits cross layers. FINAL_VERDICTS classifies
# those, read the same way (changed files per layer, capability pointers). Codes as in the classification, plus
#   metricreg  available-metric's known values are generated from the delivery metric definitions; other
#              layers type the field as the kernel metric_id (the star analysis's split of available-metric)
FINAL_VERDICTS = {
    "1431b6efa0": ("P", "caps", "vendor metric in delivery-metrics; reporting_capabilities moves to delivery's "
                   "declaration fragment, the product filter stays in supply"),
    "15df9e107e": ("L", "caps", "list_collections; the capabilities rule moves to supply's fragment"),
    "2e7994cf9a": ("L", "metricreg", "print metrics added to delivery-metrics and to available-metric"),
    "3cea56c45a": ("L", "caps", "capability-only change; anonymous_discovery is supply's fragment"),
    "3f7c46160b": ("L", "metricreg", "plays metric added to delivery-metrics and to available-metric"),
    "4f08ba1126": ("L", "metricreg", "five metric scalars added to delivery-metrics and to available-metric"),
    "66bb73322f": ("L", "caps", "extend_hold; the hold_extension capability rule moves to offer's fragment"),
    "6a5ceb9bfd": ("L", "metricreg", "leaf metric identities in available-metric and sort-metric"),
    "a35dfdb6b5": ("L", "metricreg", "time_based_views in delivery-metrics and available-metric"),
    "a793fc84a0": ("L", "metric", "metric qualifier added to committed-metric and delivery rows separately"),
    "a8aa0ab29d": ("G", "-", "billing authority flags in measurement terms and in delivery"),
    "b2ae44a927": ("L", "metricreg", "OOH metrics in delivery-metrics and available-metric"),
    "b7b6ba9171": ("L", "caps", "reporting status; reporting_capabilities and its capability rule are delivery's"),
    "ba81c91fb3": ("L", "metricreg", "viewed-seconds distributions in delivery-metrics and available-metric"),
    "dbc5b56172": ("X", "-", "tree-wide SDK-generation hygiene"),
    # v2 only: media-buy-commitment-response sits in supply
    "1406ff1ce3": ("L", "kernel", "expected_confirmation_at on the submitted envelope; async variants and the "
                   "envelope come from the kernel template"),
}
verdict = {r["sha"]: r for r in csv.DictReader(open(os.path.join(INPUTS, "buying-layers-classification.csv")))}
for sha, (v, fx, note) in FINAL_VERDICTS.items():
    verdict.setdefault(sha, {"sha": sha, "verdict": v, "fix": fx, "note": note, "source": "final"})
cross_l = [r for r in bsel if len(layers(r)) > 1]
loc = [r for r in cross_l if verdict.get(r["sha"], {}).get("verdict") == "L"]
out["buying_layers"].update(
    cross_layer=len(cross_l), cross_layer_read=sum(1 for r in cross_l if r["sha"] in verdict),
    localized_by_fixes=len(loc), fixes_localized=dict(Counter(verdict[r["sha"]]["fix"] for r in loc)),
    single_layer_after_fixes=len(one) + len(loc),
    single_layer_after_fixes_pct=round(100 * (len(one) + len(loc)) / len(bsel), 1) if bsel else None,
    # fixes that keep the wire bytes (generated assemblies, shared formats by $ref, placement); "dual" and
    # "union" change payloads and are optional cleanups in the byte-preserving layout
    single_layer_after_wire_identical_fixes=len(one) + sum(1 for r in loc if verdict[r["sha"]]["fix"] not in
                                                            ("dual", "union", "changeright")),
    cross_layer_not_read=[f"{r['sha']} #{r['pr']} {'+'.join(sorted(layers(r), key=ORDER.index))}: {r['subject'][:70]}"
                          for r in cross_l if r["sha"] not in verdict])

# ---------------------------------------------------------------- releases
rel = list(csv.DictReader(open(os.path.join(agg, "release_modules.csv"))))
kern = {"kernel", "kernel-types"}
mods = lambda r: set(r["modules"].split())  # noqa: E731
GROUPS = {"governance": ["module:governance"], "reporting": ["module:reporting"],
          "trusted-match": ["module:trusted-match"], "signals": ["module:signals"],
          "creative": ["module:creative"], "accounts": ["module:accounts"], "identity": ["module:identity"],
          "sponsored-intelligence": ["module:sponsored-intelligence"],
          "buying (all layers)": [f"module:buying/{l}" for l in ORDER],
          "buying without offer and catalogs": [f"module:buying/{l}" for l in ORDER if l not in ("offer", "catalogs")]}
if any("module:catalogs" in mods(r) for r in rel) or any("module:catalogs" in r["modules"] for r in rows):
    GROUPS["catalogs"] = ["module:catalogs"]
imp = {}
for g, ms in GROUPS.items():
    ms = set(ms)
    imp[g] = {"own": sum(bool(mods(r) & ms) for r in rel), "own_or_kernel": sum(bool(mods(r) & (ms | kern)) for r in rel),
              "own_nonadditive": sum(bool(set(r["modules_nonadditive"].split()) & ms) for r in rel)}
out["implementers"] = imp
lay = {}
for l in ORDER:
    own = {f"module:buying/{l}"}
    below = {f"module:buying/{x}" for x in DEPS[l]}
    lay[l] = {"own": sum(bool(mods(r) & own) for r in rel),
              "own_nonadditive": sum(bool(set(r["modules_nonadditive"].split()) & own) for r in rel),
              "own_or_kernel": sum(bool(mods(r) & (own | kern)) for r in rel),
              "with_lower_layers_and_kernel": sum(bool(mods(r) & (own | below | kern)) for r in rel)}
out["layer_releases"] = lay
out["ga_releases"] = len(rel)
out["kernel_releases"] = sum(1 for r in rel if mods(r) & kern)
dump(out, os.path.join(RAW, f"metrics-{name}.json"))
print(json.dumps({k: v for k, v in out.items() if k not in ("top_pairs_post_no_sweeps",)}, ensure_ascii=False))
