"""Co-change matrix (post-GA, substantive, sweeps excluded) combined with the $ref graph.

Usage: python3 -I cochange.py [N]   (N = sweep threshold: a commit touching more than N kernel-cut
non-kernel modules is a sweep; default 8)

Writes raw/:
  sweeps.json             commits excluded as sweeps (fixed list, reused for every cut)
  module_pairs_cut-29.csv     kernel-cut module pairs: co-change counts, normalised scores, $ref edges, DAG relation
  file_affinity.csv       per non-kernel file: own kernel-cut module, commits, co-change share per other module
  cluster_trace.md        constrained agglomerative clustering of kernel-cut modules (convex merges only)
"""
import csv
import itertools
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CUT2, History, caps_owner_map, commit_label_sets, labels_of, layer_of,  # noqa: E402
                    load_json)

N = int(sys.argv[1]) if len(sys.argv) > 1 else 8
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")
os.makedirs(OUT, exist_ok=True)

h = History()
L = labels_of(os.path.join(CUT2, "placement2.json"))
cmap, cdef = caps_owner_map(os.path.join(CUT2, "caps2.json"))
dag = load_json(os.path.join(CUT2, "dag2.json"))
cs_all = commit_label_sets(h, L, cmap, cdef)


def nk(labels):
    return {x for x in labels if layer_of(x) == "module"}


# ---------------------------------------------------------------- sweeps
sweeps = []
for sha, v in cs_all.items():
    n = len(nk(v["labels"]))
    if n > N:
        c = h.commits[sha]
        sweeps.append({"sha": sha, "pr": c["pr"], "window": c["window"], "cut_29_modules": n,
                       "subject": c["subject"]})
sweeps.sort(key=lambda s: -s["cut_29_modules"])
import json  # noqa: E402
json.dump({"N": N, "rule": f"substantive commit touching more than {N} non-kernel modules of the 29-module kernel cut",
           "commits": sweeps}, open(os.path.join(OUT, "sweeps.json"), "w"), indent=1)
SW = {s["sha"] for s in sweeps}

post = {sha: v for sha, v in cs_all.items()
        if h.commits[sha]["window"] != "pre-3.0" and sha not in SW}

# ---------------------------------------------------------------- module pairs
mods = sorted({m for m in L.values() if layer_of(m) == "module"})
n_m = Counter()
n_ab = Counter()
for v in post.values():
    s = sorted(nk(v["labels"]))
    for m in s:
        n_m[m] += 1
    for a, b in itertools.combinations(s, 2):
        n_ab[(a, b)] += 1

ref = Counter()
with open(os.path.join(CUT2, "edges.csv")) as fh:
    for e in csv.DictReader(fh):
        a, b = L.get(e["src"]), L.get(e["dst"])
        if a and b and a != b and layer_of(a) == "module" and layer_of(b) == "module":
            ref[(a, b)] += 1

clos = {}


def closure(m):
    if m not in clos:
        clos[m] = set()
        for d in dag.get(m, []):
            clos[m] |= {d} | closure(d)
    return clos[m]


def rel(a, b):
    if b in closure(a):
        return f"{a.split(':')[1]} -> {b.split(':')[1]}"
    if a in closure(b):
        return f"{b.split(':')[1]} -> {a.split(':')[1]}"
    return "unrelated"


def score(a, b):
    """Combined affinity: co-change ratio plus a small $ref term."""
    a, b = sorted((a, b))
    co = n_ab[(a, b)]
    lo = min(n_m[a], n_m[b]) or 1
    ratio = co / lo
    jac = co / ((n_m[a] + n_m[b] - co) or 1)
    refs = ref[(a, b)] + ref[(b, a)]
    return co, ratio, jac, refs, 0.7 * jac + 0.2 * ratio * (co >= 5) + 0.1 * min(refs, 10) / 10


with open(os.path.join(OUT, "module_pairs_cut-29.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["a", "b", "n_a", "n_b", "co_commits", "ratio_min", "jaccard", "ref_a_to_b", "ref_b_to_a",
                "dag_relation", "score"])
    rows = []
    for a, b in itertools.combinations(mods, 2):
        co, ratio, jac, refs, sc = score(a, b)
        if co or refs:
            rows.append([a, b, n_m[a], n_m[b], co, f"{ratio:.2f}", f"{jac:.2f}", ref[(a, b)], ref[(b, a)],
                         rel(a, b), f"{sc:.3f}"])
    rows.sort(key=lambda r: -float(r[-1]))
    w.writerows(rows)

# ---------------------------------------------------------------- file affinity
file_commits = defaultdict(set)
for sha, v in post.items():
    for f in v["files"]:
        if layer_of(L.get(f, "unplaced")) == "module":
            file_commits[f].add(sha)
with open(os.path.join(OUT, "file_affinity.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["file", "cut_29_module", "commits", "with_own_module_other_files", "top_other_module",
                "top_other_share", "others"])
    for f, shas in sorted(file_commits.items(), key=lambda x: -len(x[1])):
        own = L[f]
        other = Counter()
        own_n = 0
        for sha in shas:
            v = post[sha]
            if any(L.get(g) == own for g in v["files"] if g != f):
                own_n += 1
            for m in nk(v["labels"]) - {own}:
                other[m] += 1
        top = other.most_common(1)[0] if other else ("", 0)
        w.writerow([f, own, len(shas), own_n, top[0], f"{top[1] / len(shas):.2f}",
                    " ".join(f"{m.split(':')[1]}:{c}" for m, c in other.most_common(5))])

# ---------------------------------------------------------------- constrained clustering
# Merge the pair with the highest combined affinity, as long as the merge is convex in the
# declared DAG (every module on a path between the two clusters joins too, so the quotient
# stays acyclic). Stop at 1 cluster; the trace shows each step and the remaining cross share.
clusters = {m: {m} for m in mods if m != "module:compliance-testing"}


def quotient_paths(ca, cb):
    """Modules lying on a declared path between cluster ca and cluster cb (either direction)."""
    def between(src, dst):
        out = set()
        for m in mods:
            if m in src or m in dst:
                continue
            if any(m in closure(s) for s in src) and any(d in closure(m) for d in dst):
                out.add(m)
        return out
    return between(ca, cb) | between(cb, ca)


def cluster_score(ca, cb):
    tot = 0.0
    n = 0
    for a in ca:
        for b in cb:
            tot += score(a, b)[4]
            n += 1
    return tot / n


def cross_share(assign):
    cross = 0
    for v in post.values():
        if len({assign[m] for m in nk(v["labels"]) if m in assign}) >= 2:
            cross += 1
    return cross / len(post)


trace = [f"# Constrained agglomerative clustering of kernel-cut modules\n",
         f"Post-GA substantive commits, sweeps (> {N} kernel-cut modules) excluded: {len(post)}. "
         f"compliance-testing is a leaf and stays separate.\n",
         "| step | clusters | merged | pulled in to stay convex | score | cross-module share |",
         "|---|---|---|---|---|---|"]
step = 0
while len(clusters) > 4:
    best = None
    keys = list(clusters)
    for i, j in itertools.combinations(keys, 2):
        sc = cluster_score(clusters[i], clusters[j])
        if best is None or sc > best[0]:
            best = (sc, i, j)
    sc, i, j = best
    extra = quotient_paths(clusters[i], clusters[j])
    merged = clusters.pop(i) | clusters.pop(j)
    pulled = []
    for k in list(clusters):
        if clusters[k] & extra:
            merged |= clusters.pop(k)
            pulled.append(k)
    name = min(merged)
    clusters[name] = merged
    step += 1
    assign = {m: k for k, ms in clusters.items() for m in ms}
    assign["module:compliance-testing"] = "module:compliance-testing"
    trace.append(f"| {step} | {len(clusters) + 1} | {i.split(':')[1]} + {j.split(':')[1]} | "
                 f"{', '.join(p.split(':')[1] for p in pulled) or '–'} | {sc:.3f} | "
                 f"{100 * cross_share(assign):.1f}% |")
    if len(clusters) + 1 in (12, 10, 8, 6):
        trace.append("")
        trace.append(f"Clusters at {len(clusters) + 1}:")
        for k, ms in sorted(clusters.items(), key=lambda x: -len(x[1])):
            trace.append(f"- {', '.join(sorted(m.split(':')[1] for m in ms))}")
        trace.append("")
        trace.append("| step | clusters | merged | pulled in to stay convex | score | cross-module share |")
        trace.append("|---|---|---|---|---|---|")
open(os.path.join(OUT, "cluster_trace.md"), "w").write("\n".join(trace) + "\n")
print(f"sweeps: {len(sweeps)}; post-GA non-sweep substantive commits: {len(post)}")
