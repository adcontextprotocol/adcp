"""Directory-level analysis of the $ref graph produced by build_graph.py.

Usage: python3 -I analyze_dirs.py <raw dir>
Writes raw/dir_matrix.md, raw/dir_sccs.json, raw/footprints.json, raw/leaks.json
"""
import json
import os
import sys
from collections import defaultdict, Counter

RAW = sys.argv[1]
nodes = json.load(open(os.path.join(RAW, "nodes.json")))

SHARED = {"core", "enums", "pricing-options", "error-details", "extensions", "registries", "_registry"}
CAPS = "protocol/get-adcp-capabilities-response.json"


def mod(f):
    return nodes[f]["module"]


# ---- module-level matrix
mat = Counter()
for f, n in nodes.items():
    for d in n["out"]:
        if mod(f) != mod(d):
            mat[(mod(f), mod(d))] += 1
mods = sorted({n["module"] for n in nodes.values()})
fan_out = {m: len({d for (s, d) in mat if s == m}) for m in mods}
fan_in = {m: len({s for (s, d) in mat if d == m}) for m in mods}


# ---- SCC (Tarjan) over a generic adjacency
def tarjan(vs, adj):
    idx, low, on, st, out = {}, {}, set(), [], []
    c = [0]
    sys.setrecursionlimit(100000)

    def sc(v):
        idx[v] = low[v] = c[0]
        c[0] += 1
        st.append(v)
        on.add(v)
        for w in adj.get(v, ()):
            if w not in idx:
                sc(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], idx[w])
        if low[v] == idx[v]:
            comp = []
            while True:
                w = st.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            out.append(sorted(comp))

    for v in vs:
        if v not in idx:
            sc(v)
    return out


madj = defaultdict(set)
for (s, d) in mat:
    madj[s].add(d)
msccs = [c for c in tarjan(mods, madj) if len(c) > 1]

# file-level SCCs
fadj = {f: n["out"] for f, n in nodes.items()}
fsccs = [c for c in tarjan(list(nodes), fadj) if len(c) > 1]

# ---- footprints: which non-shared modules reach each shared file
#   traversal from module M's files; walk into SHARED files only.
def footprint(exclude=()):
    users = defaultdict(set)
    for f, n in nodes.items():
        m = mod(f)
        if m in SHARED or f in exclude:
            continue
        stack, seen = list(n["out"]), set()
        while stack:
            d = stack.pop()
            if d in seen or d in exclude:
                continue
            seen.add(d)
            if mod(d) in SHARED:
                users[d].add(m)
                stack.extend(nodes[d]["out"])
    return users


fp_all = footprint()
fp_nocaps = footprint(exclude={CAPS, "compliance/comply-test-controller-request.json",
                               "compliance/comply-test-controller-response.json"})
shared_files = [f for f in nodes if mod(f) in SHARED and mod(f) not in ("_registry", "extensions", "registries")]
fps = {}
for f in shared_files:
    fps[f] = {"all": sorted(fp_all.get(f, ())), "no_caps_no_compliance": sorted(fp_nocaps.get(f, ()))}
cnt_all = Counter(len(v["all"]) for v in fps.values())
cnt_nc = Counter(len(v["no_caps_no_compliance"]) for v in fps.values())
single = Counter()
for f, v in fps.items():
    if len(v["no_caps_no_compliance"]) == 1:
        single[(mod(f), v["no_caps_no_compliance"][0])] += 1

# ---- leaks: domain file -> other domain file
leaks = defaultdict(list)
for f, n in nodes.items():
    if mod(f) in SHARED:
        continue
    for d in n["out"]:
        if mod(d) not in SHARED and mod(d) != mod(f):
            leaks[f"{mod(f)} -> {mod(d)}"].append(f"{f} -> {d}")
# shared -> domain (core refs domain: inversion)
inversions = defaultdict(list)
for f, n in nodes.items():
    if mod(f) not in SHARED:
        continue
    for d in n["out"]:
        if mod(d) not in SHARED:
            inversions[f"{mod(f)} -> {mod(d)}"].append(f"{f} -> {d}")

json.dump({"module_sccs": msccs, "file_sccs": fsccs}, open(os.path.join(RAW, "dir_sccs.json"), "w"), indent=1)
json.dump(fps, open(os.path.join(RAW, "footprints.json"), "w"), indent=1)
json.dump({"leaks": leaks, "inversions_shared_to_domain": inversions},
          open(os.path.join(RAW, "leaks.json"), "w"), indent=1)

with open(os.path.join(RAW, "dir_matrix.md"), "w") as fh:
    active = [m for m in mods if fan_in[m] or fan_out[m]]
    fh.write("| from \\ to | " + " | ".join(active) + " |\n")
    fh.write("|---" * (len(active) + 1) + "|\n")
    for s in active:
        fh.write(f"| {s} | " + " | ".join(str(mat.get((s, d), "")) for d in active) + " |\n")

print("modules:", len(mods))
print("fan-out/fan-in:")
for m in mods:
    files_n = sum(1 for n in nodes.values() if n["module"] == m)
    print(f"  {m:24s} files={files_n:4d} out={fan_out[m]:2d} in={fan_in[m]:2d}")
print("module SCCs:", msccs)
print("file SCCs:", len(fsccs), [len(c) for c in fsccs][:20])
print("shared-file footprint size (all):", sorted(cnt_all.items()))
print("shared-file footprint size (excl caps+compliance):", sorted(cnt_nc.items()))
print("single-domain shared files by (dir, domain):")
for k, v in single.most_common():
    print("  ", k, v)
print("leak pairs:")
for k, v in sorted(leaks.items(), key=lambda kv: -len(kv[1])):
    print(f"  {k}: {len(v)}")
print("inversions shared->domain:")
for k, v in sorted(inversions.items(), key=lambda kv: -len(kv[1])):
    print(f"  {k}: {len(v)}")
