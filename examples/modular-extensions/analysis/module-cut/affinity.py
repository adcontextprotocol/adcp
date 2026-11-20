"""Misplacement candidates for a cut: files whose post-GA commits mostly touch another module.

Usage: python3 -I affinity.py <cut dir under raw/> [min commits, default 3]

For every module file with at least <min> post-GA substantive non-sweep commits, counts the
commits in which another file of its own module also changed (own) and, per other module X, the
commits in which X also changed. A file is a candidate when some X >= 2 * own and X >= <min>.
Writes raw/<cut>/affinity.csv and prints the candidates.
"""
import csv
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import History, caps_owner_map, commit_label_sets, labels_of, layer_of, load_json  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
cut = os.path.join(HERE, "raw", sys.argv[1])
MIN = int(sys.argv[2]) if len(sys.argv) > 2 else 3
h = History()
L = labels_of(os.path.join(cut, "placement.json"))
cmap, cdef = caps_owner_map(os.path.join(cut, "caps.json"))
sw = {s["sha"] for s in load_json(os.path.join(HERE, "raw", "sweeps.json"))["commits"]}
cs = {s: v for s, v in commit_label_sets(h, L, cmap, cdef).items()
      if s not in sw and h.commits[s]["window"] != "pre-3.0"}
fc = defaultdict(set)
for s, v in cs.items():
    for f in v["files"]:
        if layer_of(L.get(f, "unplaced")) == "module":
            fc[f].add(s)
rows = []
for f, shas in fc.items():
    own_m = L[f]
    own = sum(1 for s in shas if any(L.get(g) == own_m for g in cs[s]["files"] if g != f))
    other = Counter()
    for s in shas:
        for m in cs[s]["labels"]:
            if m != own_m and layer_of(m) == "module" and m != "module:compliance-testing":
                other[m] += 1
    top, n = other.most_common(1)[0] if other else ("", 0)
    rows.append([f, own_m, len(shas), own, top, n, " ".join(f"{m.split(':')[1]}:{c}" for m, c in other.most_common(4))])
rows.sort(key=lambda r: (-(r[5] - r[3]), -r[2]))
with open(os.path.join(cut, "affinity.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["file", "module", "commits", "own_cochange", "top_other", "top_other_commits", "others"])
    w.writerows(rows)
for r in rows:
    if r[2] >= MIN and r[5] >= MIN and r[5] >= 2 * r[3]:
        print(r)
