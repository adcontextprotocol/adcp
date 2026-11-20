"""Comparable metrics for one cut from aggregate.py output.

Usage: python3 -I metrics.py <name> <agg dir> <groups.json> [--layers layers.json] [--dag dag.json]

Reads <agg dir>/summary.json, commit_modules.csv, release_modules.csv and raw/sweeps.json.
Prints one JSON object (also written to raw/metrics-<name>.json):
  kernel share of post-GA file changes and non-additive file changes;
  cross-module share (2+ non-kernel modules) of substantive commits, all windows and post-GA,
  with and without sweeps; 5+ module commits with and without sweeps;
  per-implementer GA release counts; top non-kernel pairs post-GA without sweeps, with DAG relation.
"""
import argparse
import csv
import itertools
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_json  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("agg")
ap.add_argument("groups")
ap.add_argument("--layers")
ap.add_argument("--dag")
a = ap.parse_args()
HERE = os.path.dirname(os.path.abspath(__file__))
layers = load_json(a.layers) if a.layers else {}


def layer(m):
    if m in layers:
        return layers[m]
    if m in {"core", "core?orphan", "protocol", "identity"} or m.startswith("kernel"):
        return "kernel"
    if m.startswith("_") or m == "assembly":
        return "assembly"
    if m == "retire":
        return "retire"
    return "module"  # the first placement's x-* labels count as modules here, as in the churn co-change view


S = load_json(os.path.join(a.agg, "summary.json"))
sweeps = {s["sha"][:10] for s in load_json(os.path.join(HERE, "raw", "sweeps.json"))["commits"]}
post_w = [w for w in ("3.0->3.1", "3.1->3.2", "3.2->now")]
blw = S["by_layer_window"]
fc = sum(blw[f"total|{w}"]["file_changes"] for w in post_w)
fcn = sum(blw[f"total|{w}"]["fc_nonadditive"] for w in post_w)
kfc = sum(blw.get(f"kernel|{w}", {}).get("file_changes", 0) for w in post_w)
kfcn = sum(blw.get(f"kernel|{w}", {}).get("fc_nonadditive", 0) for w in post_w)

rows = list(csv.DictReader(open(os.path.join(a.agg, "commit_modules.csv"))))
dag = load_json(a.dag) if a.dag else {}
clos = {}


def closure(m):
    if m not in clos:
        clos[m] = set()
        for d in dag.get(m, []):
            clos[m] |= {d} | closure(d)
    return clos[m]


def rel(x, y):
    if not dag:
        return ""
    if y in closure(x):
        return f"{x.split(':')[-1]} → {y.split(':')[-1]}"
    if x in closure(y):
        return f"{y.split(':')[-1]} → {x.split(':')[-1]}"
    return "none"


def stats(sel):
    n = len(sel)
    cross = 0
    five = 0
    for r in sel:
        nk = {m for m in r["modules"].split() if layer(m) not in ("kernel", "assembly", "retire")}
        if len(nk) >= 2:
            cross += 1
        if len(nk) >= 5:
            five += 1
    return n, cross, five


allc = rows
nosw = [r for r in rows if r["sha"] not in sweeps]
post = [r for r in rows if r["window"] != "pre-3.0"]
post_nosw = [r for r in post if r["sha"] not in sweeps]
out = {"name": a.name,
       "kernel_share_post_ga_fc": [kfc, fc, round(100 * kfc / fc, 1)],
       "kernel_share_post_ga_nonadd_fc": [kfcn, fcn, round(100 * kfcn / fcn, 1)]}
CT = {"module:compliance-testing", "x-compliance-testing"}
for key, sel in (("all", allc), ("all_no_sweeps", nosw), ("post", post), ("post_no_sweeps", post_nosw),
                 ("post_no_sweeps_no_ct", [dict(r, modules=" ".join(m for m in r["modules"].split() if m not in CT))
                                           for r in post_nosw])):
    n, cross, five = stats(sel)
    out[key] = {"commits": n, "cross": cross, "cross_pct": round(100 * cross / n, 1), "five_plus": five}

pairs = Counter()
for r in post_nosw:
    nk = sorted({m for m in r["modules"].split() if layer(m) not in ("kernel", "assembly", "retire")})
    for x, y in itertools.combinations(nk, 2):
        pairs[(x, y)] += 1
out["top_pairs_post_no_sweeps"] = [[x, y, n, rel(x, y)] for (x, y), n in pairs.most_common(15)]
pairs_all = Counter()
for r in nosw:
    nk = sorted({m for m in r["modules"].split() if layer(m) not in ("kernel", "assembly", "retire")})
    for x, y in itertools.combinations(nk, 2):
        pairs_all[(x, y)] += 1
out["top_pairs_all_no_sweeps"] = [[x, y, n, rel(x, y)] for (x, y), n in pairs_all.most_common(15)]
if dag:
    unrelated = sum(n for (x, y), n in pairs.items() if rel(x, y) == "none")
    out["pair_incidences_unrelated_post_no_sweeps"] = [unrelated, sum(pairs.values())]

# implementers
rel_rows = list(csv.DictReader(open(os.path.join(a.agg, "release_modules.csv"))))
firsts = {}
for r in rel_rows:
    firsts.setdefault(r["line"], r["tag"])
openers = set(firsts.values())
groups = load_json(a.groups)
kern = {m for r in rel_rows for m in r["modules"].split() if layer(m) == "kernel"}
imp = {}
for g, ms in groups.items():
    def hit(r, k):
        s = set(r["modules"].split())
        return bool(s & set(ms)) or (k and bool(s & kern))
    imp[g] = {"modules": ms, "changed": sum(hit(r, False) for r in rel_rows),
              "or_kernel": sum(hit(r, True) for r in rel_rows),
              "patch_changed": sum(hit(r, False) for r in rel_rows if r["tag"] not in openers),
              "patch_or_kernel": sum(hit(r, True) for r in rel_rows if r["tag"] not in openers)}
    if dag:
        deps = set(ms)
        for m in ms:
            deps |= {d for d in closure(m) if layer(d) == "module"}
        imp[g]["deps"] = sorted(deps - set(ms))
        imp[g]["with_deps"] = sum(bool(set(r["modules"].split()) & deps) for r in rel_rows)
        imp[g]["with_deps_or_kernel"] = sum(bool(set(r["modules"].split()) & (deps | kern)) for r in rel_rows)
out["implementers"] = imp
out["ga_releases"] = len(rel_rows)
out["kernel_releases"] = sum(1 for r in rel_rows if set(r["modules"].split()) & kern)
json.dump(out, open(os.path.join(HERE, "raw", f"metrics-{a.name}.json"), "w"), indent=1, ensure_ascii=False)
print(json.dumps({k: v for k, v in out.items() if not k.startswith("top_pairs")}, ensure_ascii=False))
for p in out["top_pairs_post_no_sweeps"][:10]:
    print("   ", p)
