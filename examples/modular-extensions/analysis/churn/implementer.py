"""Per-implementer update counts for module groups, from aggregate.py's release_modules.csv.

Usage: python3 -I implementer.py <release_modules.csv> <groups.json> <kernel modules, comma list>

groups.json: {"label": ["module", ...]}. Prints, per group, GA releases (out of all rows) in
which any module of the group changed beyond annotations, and in which the group or the
kernel changed, overall and excluding line-opening releases (X.Y.0 or first GA of a line).
"""
import csv
import json
import sys

rows = list(csv.DictReader(open(sys.argv[1])))
groups = json.load(open(sys.argv[2]))
kernel = set(sys.argv[3].split(","))
firsts = {}
for r in rows:
    firsts.setdefault(r["line"], r["tag"])
openers = set(firsts.values())
print(f"GA releases: {len(rows)}; line openers: {' '.join(sorted(openers))}")
print("| group | modules | group changed | group or kernel changed | patch releases: group | patch releases: group or kernel |")
print("|---|---|---|---|---|---|")
for g, mods in groups.items():
    def hit(r, with_kernel):
        ms = set(r["modules"].split())
        return bool(ms & set(mods)) or (with_kernel and bool(ms & kernel))
    a = sum(hit(r, False) for r in rows)
    b = sum(hit(r, True) for r in rows)
    c = sum(hit(r, False) for r in rows if r["tag"] not in openers)
    d = sum(hit(r, True) for r in rows if r["tag"] not in openers)
    print(f"| {g} | {', '.join(mods)} | {a} | {b} | {c} | {d} |")
