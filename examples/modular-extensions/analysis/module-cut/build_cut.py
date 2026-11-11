"""Build a candidate module cut from a spec: merged modules, sub-areas, file moves, and fixes.

Usage: python3 -I build_cut.py <spec.json> [<out dir>]   (default out: raw/<spec name>/)

Spec format:
  {"name": "balanced",
   "modules": {"<module>": {"purpose": "...", "sub_areas": {"<sub>": ["<kernel-cut module>", ...]}}},
   "file_moves": {"<path>": {"to": "<module> | kernel-types", "sub": "<sub>", "why": "..."}},
   "fixes": [{"id": "X1", "edges": ["src -> dst", ...], "fix": "..."}]}

Kernel-cut labels that are not modules (kernel, kernel-types, assembly, extension:*, retire) carry over.
Edges listed in the kernel cut's violations2.json are treated as fixed. Edges listed under "fixes"
are treated as fixed by the named fix. Every other cross-module $ref edge is a used dependency.

Writes: placement.json, layers.json, dag.json (used deps after fixes), caps.json (caps2 format),
modules.json (purpose, sub-areas, file counts, deps), cycles.json, and prints a summary.
"""
import csv
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CUT2, layer_of, load_json  # noqa: E402

spec = load_json(sys.argv[1])
here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "raw", spec["name"])
os.makedirs(out, exist_ok=True)

cut29 = load_json(os.path.join(CUT2, "placement2.json"))
cut29_lab = {p: v["label"] for p, v in cut29.items()}

cut29_to_cut = {}
cut29_to_sub = {}
for m, info in spec["modules"].items():
    for sub, cut29_mods in info["sub_areas"].items():
        for k in cut29_mods:
            assert f"module:{k}" not in cut29_to_cut, f"{k} placed twice"
            cut29_to_cut[f"module:{k}"] = f"module:{m}"
            cut29_to_sub[f"module:{k}"] = sub
missing = {v for v in cut29_lab.values() if v.startswith("module:")} - set(cut29_to_cut)
assert not missing, f"kernel-cut modules without a home in this cut: {sorted(missing)}"

placement = {}
for p, v in cut29.items():
    lab = v["label"]
    if lab in cut29_to_cut:
        placement[p] = {"label": cut29_to_cut[lab], "reason": v["reason"], "cut_29": lab, "sub_area": cut29_to_sub[lab]}
    else:
        placement[p] = {"label": lab, "reason": v["reason"], "cut_29": lab}
for p, mv in spec.get("file_moves", {}).items():
    assert p in placement, f"unknown file {p}"
    to = mv["to"]
    lab = to if to in ("kernel-types", "kernel", "assembly") or ":" in to else f"module:{to}"
    placement[p] = {"label": lab, "reason": "cut-10-move: " + mv.get("why", ""), "cut_29": cut29_lab[p],
                    "sub_area": mv.get("sub", "")}
labels = {p: v["label"] for p, v in placement.items()}

# ---------------------------------------------------------------- edges
viol = load_json(os.path.join(CUT2, "violations2.json"))
fixed = {}
for pair, edges in viol.items():
    for e in edges:
        fixed[e] = "kernel-cut " + pair
for fx in spec.get("fixes", []):
    for e in fx["edges"]:
        fixed[e] = fx["id"]

used = defaultdict(Counter)
edge_list = defaultdict(list)
with open(os.path.join(CUT2, "edges.csv")) as fh:
    for e in csv.DictReader(fh):
        a, b = labels.get(e["src"]), labels.get(e["dst"])
        if not a or not b or a == b:
            continue
        key = f"{e['src']} -> {e['dst']}"
        if key in fixed:
            continue
        used[a][b] += 1
        edge_list[(a, b)].append(key)

mods = sorted({l for l in labels.values() if layer_of(l) == "module"})


def sccs(nodes, adj):
    index, low, stack, on, res = {}, {}, [], set(), []
    counter = [0]

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        for w in adj.get(v, ()):
            if w not in nodes:
                continue
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            res.append(sorted(comp))

    sys.setrecursionlimit(10000)
    for v in nodes:
        if v not in index:
            strong(v)
    return res


graph_nodes = set(mods) | {"kernel"}
KL = lambda x: "kernel" if layer_of(x) == "kernel" else x  # kernel and kernel-types form one node
adj = defaultdict(set)
for a, bs in used.items():
    for b in bs:
        if KL(a) != KL(b):
            adj[KL(a)].add(KL(b))
comps = [c for c in sccs(sorted(graph_nodes), adj) if len(c) > 1]
cycles = []
for c in comps:
    cs = set(c)
    es = {f"{a} -> {b}": edge_list[(a, b)] for a in c for b in c if a != b and edge_list[(a, b)]}
    if "kernel" in cs:
        es.update({f"{a} -> {b}": edge_list[(a, b)] for a in ("kernel-types",) for b in c if edge_list[(a, b)]})
    cycles.append({"modules": c, "edges": es})
json.dump(cycles, open(os.path.join(out, "cycles.json"), "w"), indent=1)

# kernel closure check (L1) and extension inbound (L3)
l1 = {f"{a} -> {b}": edge_list[(a, b)] for a in ("kernel", "kernel-types") for b in used.get(a, {})
      if layer_of(b) != "kernel"}

dag = {m: sorted(b for b in used.get(m, {}) if layer_of(b) == "module") for m in mods}
for m, ds in spec.get("declared_deps", {}).items():  # extensions at an extension point depend on the host module
    dag[f"module:{m}"] = sorted(set(dag[f"module:{m}"]) | {f"module:{d}" for d in ds})
dag["kernel"] = []
dag["kernel-types"] = ["kernel"]
json.dump(dag, open(os.path.join(out, "dag.json"), "w"), indent=1)

layers = {l: layer_of(l) for l in set(labels.values())}
json.dump(layers, open(os.path.join(out, "layers.json"), "w"), indent=1, sort_keys=True)
dh = load_json(os.path.join(os.path.dirname(CUT2), "..", "churn", "placements", "cut-29-dir-heuristic.json"))
json.dump([[pre, cut29_to_cut.get(lab, lab)] for pre, lab in dh], open(os.path.join(out, "dir-heuristic.json"), "w"),
          indent=1)
json.dump(placement, open(os.path.join(out, "placement.json"), "w"), indent=1, sort_keys=True)

caps2 = load_json(os.path.join(CUT2, "caps2.json"))
caps3 = {"owners": defaultdict(lambda: {"paths": []})}
for owner, info in caps2["owners"].items():
    o3 = cut29_to_cut.get(owner, owner)
    caps3["owners"][o3]["paths"].extend(info.get("paths", []))
caps3["owners"] = dict(caps3["owners"])
json.dump(caps3, open(os.path.join(out, "caps.json"), "w"), indent=1)

files_by = Counter(labels.values())
sub_counts = defaultdict(Counter)
for p, v in placement.items():
    if v["label"].startswith("module:"):
        sub_counts[v["label"]][v.get("sub_area", "")] += 1
mods_info = {}
for m, info in spec["modules"].items():
    lab = f"module:{m}"
    mods_info[m] = {"purpose": info["purpose"], "files": files_by[lab],
                    "sub_areas": {s: {"cut_29": ks, "files": sub_counts[lab][s]} for s, ks in info["sub_areas"].items()},
                    "depends_on": [d.split(":", 1)[1] for d in dag.get(lab, [])],
                    "used_edges": {d.split(":", 1)[1]: used[lab][d] for d in dag.get(lab, [])}}
json.dump(mods_info, open(os.path.join(out, "modules.json"), "w"), indent=1)

print(f"cut {spec['name']}: {len(spec['modules'])} modules; files by layer:",
      dict(Counter(layer_of(l) for l in labels.values())))
for m, i in sorted(mods_info.items(), key=lambda x: -x[1]["files"]):
    print(f"  {m:28s} {i['files']:4d}  deps: {', '.join(i['depends_on']) or '–'}")
print(f"cycles: {len(cycles)}")
for c in cycles:
    print("  SCC", [m.split(':', 1)[-1] for m in c["modules"]])
    for pair, es in sorted(c["edges"].items(), key=lambda x: len(x[1])):
        print(f"    {pair} ({len(es)}): {es[:4]}")
if l1:
    print("kernel-closure findings:", {k: len(v) for k, v in l1.items()})
