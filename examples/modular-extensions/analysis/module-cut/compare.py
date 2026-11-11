"""One comparison table across cuts, plus sweep-threshold sensitivity.

Usage: python3 -I compare.py <cut> ...   (each needs raw/metrics-<cut>.json and raw/agg-<cut>/)
Writes raw/comparison.md.
"""
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
cuts = sys.argv[1:]
M = {c: json.load(open(os.path.join(HERE, "raw", f"metrics-{c}.json"))) for c in cuts}
# The kernel cut's module count per commit decides sweeps for any N
cut29_rows = list(csv.DictReader(open(os.path.join(HERE, "raw", "agg-cut-29", "commit_modules.csv"))))
cut29_n = {r["sha"]: len([m for m in r["modules"].split() if m.startswith("module:")]) for r in cut29_rows}


def layers_for(c):
    p = os.path.join(HERE, "raw", c, "layers.json")
    return json.load(open(p)) if os.path.exists(p) else None


def nk_count(mods, lay):
    out = 0
    for m in mods.split():
        if lay is not None:
            l = lay.get(m, "extension" if m.startswith("extension:") else "module")
            if l in ("kernel", "assembly", "retire"):
                continue
        elif m in {"core", "core?orphan", "protocol", "identity"} or m.startswith("_") or m == "retire":
            continue
        out += 1
    return out


def sens(c, n):
    lay = layers_for(c) if c != "cut-11" else None
    if c == "cut-29":
        lay = json.load(open(os.path.join(HERE, "..", "kernel-cut", "raw", "layers.json")))
    rows = list(csv.DictReader(open(os.path.join(HERE, "raw", f"agg-{c}", "commit_modules.csv"))))
    sel = [r for r in rows if r["window"] != "pre-3.0" and cut29_n.get(r["sha"], 0) <= n]
    cross = sum(1 for r in sel if nk_count(r["modules"], lay) >= 2)
    return f"{100 * cross / len(sel):.1f}%"


def row(label, f):
    return "| " + label + " | " + " | ".join(str(f(M[c])) for c in cuts) + " |"


md = ["| metric | " + " | ".join(cuts) + " |", "|---|" + "---|" * len(cuts)]
md.append(row("post-GA file changes in the kernel", lambda m: f"{m['kernel_share_post_ga_fc'][2]}%"))
md.append(row("post-GA non-additive file changes in the kernel", lambda m: f"{m['kernel_share_post_ga_nonadd_fc'][2]}%"))
md.append(row("commits touching 2+ modules, all windows (with sweeps)",
              lambda m: f"{m['all']['cross']} ({m['all']['cross_pct']}%)"))
md.append(row("…without sweeps", lambda m: f"{m['all_no_sweeps']['cross']} ({m['all_no_sweeps']['cross_pct']}%)"))
md.append(row("…post-GA without sweeps", lambda m: f"{m['post_no_sweeps']['cross']} ({m['post_no_sweeps']['cross_pct']}%)"))
md.append(row("…post-GA without sweeps or compliance-testing", lambda m: f"{m['post_no_sweeps_no_ct']['cross_pct']}%"))
md.append(row("commits touching 5+ modules, all windows (with sweeps)", lambda m: m["all"]["five_plus"]))
md.append(row("…post-GA without sweeps", lambda m: m["post_no_sweeps"]["five_plus"]))
md.append(row("post-GA pair incidences off the dependency DAG",
              lambda m: "{}/{}".format(*m.get("pair_incidences_unrelated_post_no_sweeps", ["–", "–"]))))
md.append(row("GA releases with a kernel change", lambda m: m["kernel_releases"]))
for g in ["governance", "signals", "creative/formats", "buying", "accounts/onboarding", "reporting"]:
    md.append(row(f"{g}: releases changed / +kernel / +deps", lambda m, g=g: "{} / {} / {}".format(
        m["implementers"][g]["changed"], m["implementers"][g]["or_kernel"], m["implementers"][g].get("with_deps", "–"))))
md.append("")
md.append("Sweep threshold sensitivity, post-GA cross-module share without sweeps:")
md.append("")
md.append("| N | sweeps (all windows) | " + " | ".join(cuts) + " |")
md.append("|---|---|" + "---|" * len(cuts))
for n in (6, 8, 12):
    nsw = sum(1 for v in cut29_n.values() if v > n)
    md.append(f"| {n} | {nsw} | " + " | ".join(sens(c, n) for c in cuts) + " |")
open(os.path.join(HERE, "raw", "comparison.md"), "w").write("\n".join(md) + "\n")
print("\n".join(md))
