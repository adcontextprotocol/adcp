"""Commits behind each remaining module pair of a cut (post-GA, substantive, sweeps excluded).

Usage: python3 -I couplings.py <cut dir under raw/> [top pairs, default 10]

Writes raw/<cut>/couplings.md: per pair, each commit with PR, subject and the files on each side
(capabilities fragments shown as caps:<owner>), so the cause of each coupling can be read off.
"""
import itertools
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CAPS, History, caps_owner_map, caps_owners_of_fc, labels_of, layer_of,  # noqa: E402
                    load_json)

HERE = os.path.dirname(os.path.abspath(__file__))
cut = os.path.join(HERE, "raw", sys.argv[1])
TOP = int(sys.argv[2]) if len(sys.argv) > 2 else 10
h = History()
L = labels_of(os.path.join(cut, "placement.json"))
cmap, cdef = caps_owner_map(os.path.join(cut, "caps.json"))
sw = {s["sha"] for s in load_json(os.path.join(HERE, "raw", "sweeps.json"))["commits"]}
mod_of = h.resolver(L, [tuple(x) for x in load_json(os.path.join(cut, "dir-heuristic.json"))])
side = defaultdict(lambda: defaultdict(set))
for c, fc, path, cur, cls in h.rows():
    if c["window"] == "pre-3.0" or c["sha"] in sw or cls in ("annotation", "no-op"):
        continue
    if cur == CAPS:
        for o in caps_owners_of_fc(fc, cmap, cdef):
            side[c["sha"]][o].add(f"caps:{o.split(':')[-1]}")
        continue
    lab = mod_of(fc["new"] if fc["old"] and fc["new"] and fc["old"] != fc["new"] else path)
    if layer_of(lab) in ("assembly", "retire"):
        continue
    side[c["sha"]][lab].add(cur)
pairs = Counter()
pc = defaultdict(list)
for sha, d in side.items():
    nk = sorted(m for m in d if layer_of(m) not in ("kernel",))
    for a, b in itertools.combinations(nk, 2):
        pairs[(a, b)] += 1
        pc[(a, b)].append(sha)
md = [f"# Remaining couplings: {sys.argv[1]}\n", "Post-GA substantive commits, sweeps excluded.\n"]
for (a, b), n in pairs.most_common(TOP):
    md.append(f"\n## {a.split(':')[-1]} / {b.split(':')[-1]}: {n} commits\n")
    md.append("| PR | modules | subject | files in A | files in B |")
    md.append("|---|---|---|---|---|")
    for sha in sorted(pc[(a, b)], key=lambda s: h.commits[s]["date"]):
        c = h.commits[sha]
        d = side[sha]
        nmod = len([m for m in d if layer_of(m) != "kernel"])
        fa = ", ".join(sorted(x.split("/")[-1] for x in d[a])[:4])
        fb = ", ".join(sorted(x.split("/")[-1] for x in d[b])[:4])
        md.append(f"| {c['pr'] or sha[:10]} | {nmod} | {c['subject'][:70]} | {fa} | {fb} |")
open(os.path.join(cut, "couplings.md"), "w").write("\n".join(md) + "\n")
print("wrote", os.path.join(cut, "couplings.md"))
