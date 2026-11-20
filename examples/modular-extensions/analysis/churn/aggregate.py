"""Aggregate classified schema churn by layer and module for a given placement.

Usage:
  python3 -I aggregate.py --raw <raw dir> --placement <placement.json> --out <dir>
                          [--layers <layers.json>] [--caps-owners <caps_owners.json>]

--placement  JSON object {schema path relative to static/schemas/source: module}.
             Swap this file to re-cut the history with another module map.
--layers     optional JSON {module: layer}. Default: core, core?orphan, protocol and
             identity -> kernel; _assembly -> assembly; x-* -> extension; rest -> module.
--caps-owners optional JSON {capabilities top-level block: module}, used to attribute
             get-adcp-capabilities-response changes to the fragment that would own them.

Writes into --out: report.md (all tables), summary.json, kernel_nonadditive.csv,
commit_modules.csv, unplaced.csv, release_modules.csv.
"""
import argparse
import csv
import json
import os
from collections import Counter, defaultdict

ap = argparse.ArgumentParser()
ap.add_argument("--raw", required=True)
ap.add_argument("--placement", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--layers")
ap.add_argument("--caps-owners")
ap.add_argument("--dag", help="JSON {module: [declared dependencies]} for the dependency view of co-change")
ap.add_argument("--dir-heuristic", help="JSON list of [path prefix, module] used for deleted paths")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)

RAW = args.raw
placement = {p: (v["label"] if isinstance(v, dict) else v)
             for p, v in json.load(open(args.placement)).items()}
meta = json.load(open(os.path.join(RAW, "meta.json")))
commits = {c["sha"]: c for c in map(json.loads, open(os.path.join(RAW, "commits.jsonl")))}
fcs = [json.loads(line) for line in open(os.path.join(RAW, "file_changes.jsonl"))]
renames = json.load(open(os.path.join(RAW, "renames.json")))
releases = json.load(open(os.path.join(RAW, "releases.json")))
rel_changes = [json.loads(line) for line in open(os.path.join(RAW, "release_changes.jsonl"))]
WINDOWS = ["pre-3.0", "3.0->3.1", "3.1->3.2", "3.2->now"]
WINDOWS = [f"pre-{meta['milestones'][0]['name']}"] + [
    f"{meta['milestones'][i]['name']}->{meta['milestones'][i + 1]['name']}"
    for i in range(len(meta["milestones"]) - 1)] + [f"{meta['milestones'][-1]['name']}->now"]
CAPS = "protocol/get-adcp-capabilities-response.json"

# ------------------------------------------------------------------ layers
KERNEL_DEFAULT = {"core", "core?orphan", "protocol", "identity"}
layer_override = json.load(open(args.layers)) if args.layers else {}


def layer(module):
    if module in layer_override:
        return layer_override[module]
    if module in KERNEL_DEFAULT or module.startswith("kernel"):
        return "kernel"
    if module.startswith("_") or module == "assembly":
        return "assembly"
    if module.startswith("x-") or module.startswith("extension:"):
        return "extension"
    if module == "retire":
        return "retire"
    if module.startswith("unplaced"):
        return "unplaced"
    return "module"


CAPS_OWNERS_DEFAULT = {
    "adcp": "protocol", "supported_protocols": "protocol", "specialisms": "protocol",
    "experimental_features": "protocol", "extensions_supported": "protocol",
    "last_updated": "protocol", "errors": "core", "context": "core", "ext": "core",
    "#definitions": "protocol", "#root": "protocol",
    "account": "account", "media_buy": "media-buy", "signals": "signals",
    "governance": "governance", "brand": "brand", "creative": "creative",
    "sponsored_intelligence": "x-sponsored-intelligence",
    "compliance_testing": "x-compliance-testing",
    "oauth": "identity", "request_signing": "identity", "webhook_signing": "identity",
    "identity": "identity",
    "measurement": "x-measurement", "measurement_gateway": "x-measurement",
    "wholesale_feed_versioning": "discovery", "wholesale_feed_webhooks": "discovery",
    "catalog_change_feed": "discovery", "catalog_versioning": "discovery",
}
caps_owners = dict(CAPS_OWNERS_DEFAULT)
CAPS_DEFAULT_OWNER = "protocol"
if args.caps_owners:
    co = json.load(open(args.caps_owners))
    if isinstance(co.get("owners"), dict):
        # caps2.py format: {owners: {owner: {paths: ["block", "block.sub", "block (block shell)"]}}}
        caps_owners = {}
        for owner, info in co["owners"].items():
            for pth in info.get("paths", []):
                caps_owners[pth.replace(" (block shell)", "")] = owner
        CAPS_DEFAULT_OWNER = caps_owners.get("adcp", "kernel")
        for k in ("#root", "#definitions"):
            caps_owners[k] = CAPS_DEFAULT_OWNER
    else:
        caps_owners.update(co)


def caps_owner_of(ptr, blocks):
    """Owners for one capabilities record: sub-block first, then block, then default."""
    parts = [p.replace("~1", "/").replace("~0", "~") for p in ptr.strip("/").split("/")]
    if len(parts) >= 2 and parts[0] == "properties":
        if len(parts) >= 4 and parts[2] == "properties" and f"{parts[1]}.{parts[3]}" in caps_owners:
            return {caps_owners[f"{parts[1]}.{parts[3]}"]}
        return {caps_owners.get(parts[1], CAPS_DEFAULT_OWNER)}
    owners = {caps_owners.get(b, CAPS_DEFAULT_OWNER) for b in (blocks or ["#root"])}
    if len(owners) > 1:
        owners.discard(CAPS_DEFAULT_OWNER)  # experimental_features gating rides along
    return owners

# ------------------------------------------------------------------ placement
fwd = {}
for _sha, old, new in renames:  # chronological
    fwd[old] = new


def current_path(p):
    seen = set()
    while p in fwd and p not in seen:
        seen.add(p)
        p = fwd[p]
    return p


DIR_HEURISTIC = [
    ("media-buy/", "media-buy"), ("account/", "account"), ("brand/", "brand"), ("brand.json", "brand"),
    ("creative/", "creative"), ("formats/", "creative"), ("signals/", "signals"),
    ("governance/", "governance"), ("property/", "governance"), ("collection/", "governance"),
    ("content-standards/", "governance"), ("sponsored-intelligence/", "x-sponsored-intelligence"),
    ("a2ui/", "x-sponsored-intelligence"), ("trusted-match/", "x-trusted-match"),
    ("tmp/", "x-trusted-match"), ("compliance/", "x-compliance-testing"),
    ("protocol/", "protocol"), ("protocols/", "protocol"), ("trust/", "identity"),
    ("pricing-options/", "discovery"), ("adagents.json", "inventory"), ("aao/", "inventory"),
    ("adcp-agents.json", "inventory"), ("index.json", "_assembly"),
    ("core/", "core"), ("enums/", "core"), ("error-details/", "core"),
]
if args.dir_heuristic:
    DIR_HEURISTIC = [tuple(x) for x in json.load(open(args.dir_heuristic))]
deleted_referrers = {}
for fc in fcs:
    if fc["status"] == "D" and fc.get("referrers") is not None:
        deleted_referrers[fc["old"]] = fc["referrers"]

place_source = Counter()
unplaced_rows = []
_cache = {}


def module_of(path, depth=0):
    """(module, how) for a historical path."""
    if path in _cache:
        return _cache[path]
    cur = current_path(path)
    if cur in placement:
        res = (placement[cur], "placement" if cur == path else "placement-via-rename")
    else:
        res = None
        refs = [r for r in deleted_referrers.get(path, []) if r != "index.json"]
        if refs and depth < 4:
            mods = {module_of(r, depth + 1)[0] for r in refs} - {"unplaced"}
            mods = {m for m in mods if layer(m) != "assembly"}  # aggregators are not owners
            if len(mods) == 1:
                res = (mods.pop(), "referrers")
        if res is None:
            for prefix, m in DIR_HEURISTIC:
                if path.startswith(prefix):
                    res = (m, "dir-heuristic")
                    break
        if res is None:
            res = ("unplaced", "unplaced")
    _cache[path] = res
    return res


# ------------------------------------------------------------------ per file change
rows = []
for fc in fcs:
    c = commits[fc["sha"]]
    if c["bootstrap"]:
        continue
    path = fc["new"] or fc["old"]
    mod, how = module_of(path)
    if fc["old"] and fc["new"] and fc["old"] != fc["new"]:
        # renamed: count at the destination path
        mod, how = module_of(fc["new"])
    cur = current_path(path)
    exp_file = fc["file_exp_old"] or fc["file_exp_new"] or \
        meta["experimental_now"].get(cur, {}).get("file_exp", False)
    recs = fc["records"]
    if fc["n_nonadditive"]:
        cls = "non-additive"
    elif fc["n_additive"]:
        cls = "additive"
    elif fc["n_annotation"]:
        cls = "annotation"
    else:
        cls = "no-op"
    rows.append({"fc": fc, "c": c, "path": path, "cur": cur, "mod": mod, "how": how,
                 "layer": layer(mod), "cls": cls, "exp_file": exp_file, "window": c["window"]})

for r in rows:
    place_source[r["how"]] += 1
unplaced_paths = sorted({(r["path"], r["mod"], r["how"]) for r in rows
                         if r["how"] not in ("placement", "placement-via-rename")})


def caps_modules(fc, classes=("additive", "non-additive", "annotation")):
    """Modules that own the capability blocks a caps file change touched."""
    out = set()
    for rec in fc["records"]:
        if rec["cls"] not in classes:
            continue
        out |= caps_owner_of(rec["ptr"], rec.get("caps_blocks"))
    return out


# ------------------------------------------------------------------ helpers
def summarize(group_rows):
    commits_ = {r["c"]["sha"] for r in group_rows}
    cnt = Counter(r["cls"] for r in group_rows)
    rec = Counter()
    for r in group_rows:
        rec["additive"] += r["fc"]["n_additive"]
        rec["non-additive"] += r["fc"]["n_nonadditive"]
        rec["annotation"] += r["fc"]["n_annotation"]
    return {"commits": len(commits_), "file_changes": len(group_rows),
            "fc_nonadditive": cnt["non-additive"], "fc_additive": cnt["additive"],
            "fc_annotation": cnt["annotation"] + cnt["no-op"],
            "rec_additive": rec["additive"], "rec_nonadditive": rec["non-additive"],
            "rec_annotation": rec["annotation"],
            "commits_nonadditive": len({r["c"]["sha"] for r in group_rows if r["cls"] == "non-additive"}),
            "files": len({r["cur"] for r in group_rows})}


def table(headers, data):
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    for row in data:
        lines.append("| " + " | ".join(str(x) for x in row) + " |")
    return "\n".join(lines)


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "–"


md = []
summary = {"head": meta["head"], "since": meta["since"], "placement": os.path.relpath(os.path.abspath(args.placement), os.path.dirname(os.path.abspath(__file__)))}
all_commits = {r["c"]["sha"] for r in rows}
tot = summarize(rows)
summary["total"] = tot
summary["place_source"] = dict(place_source)
md.append(f"# Schema churn report\n\nHead `{meta['head'][:10]}`, first-parent since {meta['since']}, "
          f"placement `{args.placement}`.\n")
md.append(f"Commits touching schemas (excluding the bootstrap commit): {len(all_commits)}. "
          f"File changes: {len(rows)}.\n")
md.append("Placement source: " + ", ".join(f"{k} {v}" for k, v in place_source.most_common()) + "\n")

COLS = ["commits", "commits w/ non-add", "file changes", "fc non-add", "fc additive", "fc annot.",
        "rec additive", "rec non-add", "rec annot.", "distinct files"]


def srow(name, s):
    return [name, s["commits"], s["commits_nonadditive"], s["file_changes"], s["fc_nonadditive"],
            s["fc_additive"], s["fc_annotation"], s["rec_additive"], s["rec_nonadditive"],
            s["rec_annotation"], s["files"]]


# 1. by layer
by_layer = defaultdict(list)
for r in rows:
    by_layer[r["layer"]].append(r)
LAYERS = ["kernel", "module", "extension", "assembly", "retire", "unplaced"]
md.append("## By layer (all windows)\n")
md.append(table(["layer"] + COLS, [srow(l, summarize(by_layer[l])) for l in LAYERS if by_layer[l]]
                + [srow("total", tot)]))
summary["by_layer"] = {l: summarize(by_layer[l]) for l in LAYERS if by_layer[l]}

# 2. by layer x window
md.append("\n## By layer and release window\n")
lw = []
summary["by_layer_window"] = {}
for w in WINDOWS:
    for l in LAYERS:
        g = [r for r in by_layer[l] if r["window"] == w]
        if g:
            s = summarize(g)
            summary["by_layer_window"][f"{l}|{w}"] = s
            lw.append([w] + srow(l, s))
    s = summarize([r for r in rows if r["window"] == w])
    summary["by_layer_window"][f"total|{w}"] = s
    lw.append([w] + srow("**total**", s))
md.append(table(["window", "layer"] + COLS, lw))

# 3. by module
by_mod = defaultdict(list)
for r in rows:
    by_mod[r["mod"]].append(r)
md.append("\n## By module (all windows)\n")
mods_sorted = sorted(by_mod, key=lambda m: (LAYERS.index(layer(m)) if layer(m) in LAYERS else 9, -len(by_mod[m])))
md.append(table(["module", "layer"] + COLS[:], [[m, layer(m)] + srow("", summarize(by_mod[m]))[1:]
                                               for m in mods_sorted]))
summary["by_module"] = {m: summarize(by_mod[m]) for m in mods_sorted}

md.append("\n## By module and window: file changes (non-additive)\n")
mw = []
summary["by_module_window"] = {}
for m in mods_sorted:
    cells = []
    for w in WINDOWS:
        g = [r for r in by_mod[m] if r["window"] == w]
        s = summarize(g)
        summary["by_module_window"][f"{m}|{w}"] = s
        cells.append(f"{s['file_changes']} ({s['fc_nonadditive']})")
    mw.append([m, layer(m)] + cells)
md.append(table(["module", "layer"] + WINDOWS, mw))

# 4. kernel non-additive list
kern = []
for r in rows:
    if r["layer"] != "kernel":
        continue
    for rec in r["fc"]["records"]:
        if rec["cls"] != "non-additive":
            continue
        kern.append({
            "window": r["window"], "date": r["c"]["date"][:10], "sha": r["c"]["sha"][:10],
            "pr": r["c"]["pr"] or "", "subject": r["c"]["subject"], "file": r["path"],
            "module": r["mod"], "kind": rec["kind"], "ptr": rec["ptr"], "detail": rec["detail"],
            "exp": rec["exp"] or r["exp_file"], "in_ga": ";".join(rec.get("in_ga", [])),
            "in_pre": ";".join(rec.get("in_pre", [])),
            "direction": "request" if r["path"].endswith("-request.json") else
            "response" if r["path"].endswith("-response.json") else "shared",
        })
with open(os.path.join(args.out, "kernel_nonadditive.csv"), "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(kern[0].keys()) if kern else ["window"])
    w.writeheader()
    w.writerows(kern)
md.append(f"\n## Non-additive records in kernel files: {len(kern)} "
          f"(in {len({(k['sha'], k['file']) for k in kern})} file changes, "
          f"{len({k['sha'] for k in kern})} commits)\n")
kw = Counter((k["window"], k["kind"]) for k in kern)
md.append(table(["window", "kind", "records"], [[w_, k_, n] for (w_, k_), n in sorted(kw.items())]))
summary["kernel_nonadditive_by_window"] = dict(Counter(k["window"] for k in kern))
summary["kernel_nonadditive_commits_by_window"] = {
    w_: len({k["sha"] for k in kern if k["window"] == w_}) for w_ in WINDOWS}
rel_flags = Counter()
for k in kern:
    rel_flags[(k["window"], "released-GA" if k["in_ga"] else "prerelease-only" if k["in_pre"]
               else "never-released")] += 1
md.append("\nReleased status of the element each kernel non-additive record touched:\n")
md.append(table(["window", "status", "records"], [[a, b, n] for (a, b), n in sorted(rel_flags.items())]))
summary["kernel_release_status"] = {f"{a}|{b}": n for (a, b), n in rel_flags.items()}

# 4b. release status of non-additive records, every layer
rs_all = Counter()
for r in rows:
    for rec in r["fc"]["records"]:
        if rec["cls"] != "non-additive":
            continue
        st = "released-GA" if rec.get("in_ga") else "prerelease-only" if rec.get("in_pre") else "never-released"
        rs_all[(r["layer"], r["window"], st)] += 1
md.append("\nRelease status of non-additive records, all layers:\n")
md.append(table(["layer", "window", "released-GA", "prerelease-only", "never-released"],
                [[l, w_, rs_all[(l, w_, "released-GA")], rs_all[(l, w_, "prerelease-only")],
                  rs_all[(l, w_, "never-released")]] for l in LAYERS for w_ in WINDOWS
                 if any(rs_all[(l, w_, s_)] for s_ in ("released-GA", "prerelease-only", "never-released"))]))
summary["release_status_all"] = {f"{a}|{b}|{c}": n for (a, b, c), n in rs_all.items()}

# 5. co-change
AGG = {p for p, m in placement.items() if layer(m) == "assembly"}
summary["aggregators"] = sorted(AGG)


def commit_modules(substantive):
    out = {}
    for r in rows:
        if substantive and r["cls"] in ("annotation", "no-op"):
            continue
        out.setdefault(r["c"]["sha"], []).append(r)
    return out


commits_by_short = {sha[:10]: c["window"] for sha, c in commits.items()}


def cochange(substantive, caps_split):
    cm = commit_modules(substantive)
    res = Counter()
    pairs = Counter()
    pairs_nk = Counter()
    detail = []
    sizes = Counter()
    for sha, rs in cm.items():
        mods_all = {r["mod"] for r in rs}
        mods_x = set()
        for r in rs:
            if r["layer"] == "retire":
                continue
            if r["cur"] in AGG or r["layer"] == "assembly":
                if caps_split and r["cur"] == CAPS:
                    cls = ("additive", "non-additive") if substantive else \
                        ("additive", "non-additive", "annotation")
                    mods_x |= caps_modules(r["fc"], cls)
                continue
            mods_x.add(r["mod"])
        non_kernel = {m for m in mods_x if layer(m) != "kernel"}
        kernel = {m for m in mods_x if layer(m) == "kernel"}
        if len(mods_all) < 2:
            cat = "single-module"
        elif len(mods_x) <= 1:
            cat = "aggregator-only"
        elif len(non_kernel) <= 1:
            cat = "kernel+one-module" if non_kernel else "kernel-internal"
        else:
            cat = "cross-module"
        res[cat] += 1
        if cat == "cross-module":
            sizes[min(len(non_kernel), 6)] += 1
            for a in sorted(non_kernel):
                for b in sorted(non_kernel):
                    if a < b:
                        pairs_nk[(a, b)] += 1
        for a in sorted(mods_x):
            for b in sorted(mods_x):
                if a < b:
                    pairs[(a, b)] += 1
        detail.append({"sha": sha[:10], "pr": commits[sha]["pr"] or "", "window": commits[sha]["window"],
                       "category": cat, "modules": " ".join(sorted(mods_x)),
                       "all_modules": " ".join(sorted(mods_all)),
                       "subject": commits[sha]["subject"]})
    return res, pairs, pairs_nk, detail, sizes


md.append("\n## Co-change\n")
md.append("Aggregator files (assembly layer): " + ", ".join(f"`{a}`" for a in sorted(AGG)) + "\n")
summary["cochange"] = {}
for substantive in (False, True):
    for caps_split in (False, True):
        res, pairs, pairs_nk, detail, sizes = cochange(substantive, caps_split)
        key = f"{'substantive' if substantive else 'all'}|{'caps-split' if caps_split else 'caps-as-aggregator'}"
        n = sum(res.values())
        multi = n - res["single-module"]
        summary["cochange"][key] = {"commits": n, "multi_module": multi, **res,
                                    "cross_module_size": {str(k): v for k, v in sorted(sizes.items())},
                                    "top_pairs_non_kernel": [[a, b, c] for (a, b), c in pairs_nk.most_common(15)],
                                    "top_pairs_all": [[a, b, c] for (a, b), c in pairs.most_common(15)]}
        md.append(f"\n### {key}\n")
        md.append(table(["category", "commits", "share of multi-module"],
                        [[k, res[k], pct(res[k], multi) if k != "single-module" else "–"]
                         for k in ["single-module", "aggregator-only", "kernel-internal",
                                   "kernel+one-module", "cross-module"]] + [["total", n, ""]]))
        md.append("\nCross-module commits by number of non-kernel modules: " +
                  ", ".join(f"{k}{'+' if k == 6 else ''}: {v}" for k, v in sorted(sizes.items())) + "\n")
        md.append("\nTop non-kernel module pairs:\n")
        md.append(table(["module A", "module B", "commits"],
                        [[a, b, c] for (a, b), c in pairs_nk.most_common(12)]))
        bywin = Counter((commits_by_short[d["sha"]], d["category"]) for d in detail)
        summary["cochange"][key]["by_window"] = {f"{a}|{b}": n for (a, b), n in bywin.items()}
        md.append("\nBy window:\n")
        cats = ["single-module", "aggregator-only", "kernel-internal", "kernel+one-module", "cross-module"]
        md.append(table(["window"] + cats, [[w_] + [bywin[(w_, c_)] for c_ in cats] for w_ in WINDOWS]))
        if key == "substantive|caps-split":
            broad = [d for d in detail if d["category"] == "cross-module" and len(
                [m for m in d["modules"].split() if layer(m) != "kernel"]) >= 5]
            md.append(f"\nBroad cross-module commits (5+ non-kernel modules): {len(broad)}\n")
            md.append(table(["sha", "PR", "window", "modules", "subject"],
                            [[d["sha"], d["pr"], d["window"], d["modules"], d["subject"][:90]] for d in broad]))
            with open(os.path.join(args.out, "commit_modules.csv"), "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=list(detail[0].keys()))
                w.writeheader()
                w.writerows(sorted(detail, key=lambda d: d["sha"]))

# dependency view of cross-module commits (needs --dag)
if args.dag:
    dag = json.load(open(args.dag))
    _clos = {}

    def closure_of(m):
        if m not in _clos:
            _clos[m] = set()
            for d in dag.get(m, []):
                _clos[m] |= {d} | closure_of(d)
        return _clos[m]

    def related(a, b):
        return a in closure_of(b) or b in closure_of(a)

    dep = Counter()
    pair_rel = Counter()
    forced = []
    for sha, rs in commit_modules(True).items():
        mods, na = set(), set()
        for r in rs:
            if r["layer"] in ("retire",):
                continue
            if r["cur"] == CAPS:
                mods |= caps_modules(r["fc"], ("additive", "non-additive"))
                na |= caps_modules(r["fc"], ("non-additive",))
                continue
            if r["layer"] == "assembly":
                continue
            mods.add(r["mod"])
            if r["cls"] == "non-additive":
                na.add(r["mod"])
        nk = {m for m in mods if layer(m) not in ("kernel", "assembly")}
        if len(nk) < 2:
            continue
        pairs = [(a, b) for a in sorted(nk) for b in sorted(nk) if a < b]
        rel = [related(a, b) for a, b in pairs]
        dep["all pairs on one dependency path" if all(rel) else
            "no pair related" if not any(rel) else "some pairs unrelated"] += 1
        for (a, b), r_ in zip(pairs, rel):
            pair_rel[(a, b, "dependency" if r_ else "unrelated")] += 1
        # forced proxy: a non-additive change in X while a module that depends on X also changes
        if any(x in closure_of(y) for x in na for y in nk if y != x):
            forced.append(sha)
    md.append("\n### Cross-module commits against the declared module DAG (substantive, caps split)\n")
    md.append(table(["relation", "commits"], dep.most_common()))
    md.append(f"\nCommits with a non-additive change in a module and a change in a module that depends on it: "
              f"{len(forced)}.\n")
    md.append(table(["module A", "module B", "relation", "commits"],
                    [[a, b, r_, n] for (a, b, r_), n in pair_rel.most_common(15)]))
    summary["dag_view"] = {"relation": dict(dep), "forced_proxy_commits": len(forced),
                           "forced_proxy_by_window": dict(Counter(commits[s_]["window"] for s_ in forced)),
                           "pairs": [[a, b, r_, n] for (a, b, r_), n in pair_rel.most_common(25)]}

# caps fragment view
caps_rows = [r for r in rows if r["cur"] == CAPS]
frag = Counter()
for r in caps_rows:
    owners = caps_modules(r["fc"])
    frag[min(len(owners), 3)] += 1
summary["caps"] = {"file_changes": len(caps_rows), "owners_touched": {str(k): v for k, v in frag.items()},
                   "commits": len({r["c"]["sha"] for r in caps_rows}),
                   "share_of_schema_commits": len({r["c"]["sha"] for r in caps_rows}) / max(1, len(all_commits))}
own_counter = Counter()
for r in caps_rows:
    for m in caps_modules(r["fc"], ("additive", "non-additive")):
        own_counter[m] += 1
summary["caps"]["owner_substantive_changes"] = dict(own_counter.most_common())
md.append(f"\n## Capabilities response as fragments\n\n{len(caps_rows)} file changes in "
          f"{summary['caps']['commits']} commits ({pct(summary['caps']['commits'], len(all_commits))} of schema commits). "
          f"Fragment owners touched per change: " + ", ".join(f"{k}{'+' if k == 3 else ''}: {v}"
                                                             for k, v in sorted(frag.items())) + ".\n")
md.append(table(["owner module", "substantive caps changes"], own_counter.most_common()))

# 6. releases: what an implementer saw
rel_by_tag = defaultdict(list)
for rc in rel_changes:
    rel_by_tag[rc["tag"]].append(rc)
rel_rows = []
GENERATED = AGG - {CAPS}
for rel in releases:
    if rel.get("baseline_missing"):
        continue
    mods = Counter()
    mods_na = Counter()
    for rc in rel_by_tag[rel["tag"]]:
        path = rc["new"] or rc["old"]
        if rc["n_additive"] + rc["n_nonadditive"] == 0:
            continue
        if path == CAPS:
            for cls, ptr, blks in rc.get("caps_recs", []):
                if cls == "annotation":
                    continue
                for m in caps_owner_of(ptr, blks):
                    mods[m] += 1
                    if cls == "non-additive":
                        mods_na[m] += 1
            continue
        if path in GENERATED:
            continue
        m, _ = module_of(path)
        mods[m] += 1
        if rc["n_nonadditive"]:
            mods_na[m] += 1
    rel_rows.append({"tag": rel["tag"], "date": rel["date"][:10], "line": rel["line"], "prev": rel["prev"],
                     "files": rel["n_files"], "modules": sorted(mods), "modules_nonadditive": sorted(mods_na),
                     "layers": sorted({layer(m) for m in mods})})
with open(os.path.join(args.out, "release_modules.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["tag", "date", "line", "prev", "files", "layers", "modules", "modules_nonadditive"])
    for rr in rel_rows:
        w.writerow([rr["tag"], rr["date"], rr["line"], rr["prev"], rr["files"], " ".join(rr["layers"]),
                    " ".join(rr["modules"]), " ".join(rr["modules_nonadditive"])])

lines_ = sorted({rr["line"] for rr in rel_rows}, key=lambda s: tuple(map(int, s.split("."))))
all_mods = sorted({m for rr in rel_rows for m in rr["modules"]} | set(by_mod),
                  key=lambda m: (LAYERS.index(layer(m)) if layer(m) in LAYERS else 9, m))
kernel_mods = {m for m in all_mods if layer(m) == "kernel"}
md.append("\n## Releases: what an implementer saw\n")
hdr = ["view"] + [f"{l} line ({sum(1 for rr in rel_rows if rr['line'] == l)} GA)" for l in lines_] + ["all"]
data = []


def count(pred, line=None):
    return sum(1 for rr in rel_rows if (line is None or rr["line"] == line) and pred(rr))


data.append(["GA releases"] + [count(lambda rr: True, l) for l in lines_] + [len(rel_rows)])
data.append(["…with any non-annotation schema change"] + [count(lambda rr: bool(rr["modules"]), l) for l in lines_]
            + [count(lambda rr: bool(rr["modules"]))])
data.append(["…with a kernel change"] + [count(lambda rr: "kernel" in rr["layers"], l) for l in lines_]
            + [count(lambda rr: "kernel" in rr["layers"])])
data.append(["…with a non-additive kernel change"] +
            [count(lambda rr: bool(kernel_mods & set(rr["modules_nonadditive"])), l) for l in lines_]
            + [count(lambda rr: bool(kernel_mods & set(rr["modules_nonadditive"])))])
for m in all_mods:
    if layer(m) in ("kernel", "assembly", "retire", "unplaced"):
        continue
    data.append([f"{m}: module or kernel changed"] +
                [count(lambda rr, m=m: m in rr["modules"] or "kernel" in rr["layers"], l) for l in lines_]
                + [count(lambda rr, m=m: m in rr["modules"] or "kernel" in rr["layers"])])
    data.append([f"{m}: module changed"] +
                [count(lambda rr, m=m: m in rr["modules"], l) for l in lines_]
                + [count(lambda rr, m=m: m in rr["modules"])])
md.append(table(hdr, data))
summary["releases"] = {"rows": rel_rows, "table_header": hdr, "table": data}

# 7. experimental share
md.append("\n## Experimental surfaces\n")
ex = Counter()
for r in rows:
    key = "experimental file" if r["exp_file"] else "stable file"
    ex[(key, "file_changes")] += 1
    ex[(key, r["cls"])] += 1
    for rec in r["fc"]["records"]:
        node_kind = "exp-marked node" if (rec["exp"] or r["exp_file"]) else "stable node"
        ex[(node_kind, rec["cls"])] += 1
summary["experimental"] = {f"{a}|{b}": n for (a, b), n in ex.items()}
md.append(table(["surface", "file changes", "non-add", "additive", "annot."],
                [[k, ex[(k, "file_changes")], ex[(k, "non-additive")], ex[(k, "additive")],
                  ex[(k, "annotation")] + ex[(k, "no-op")]] for k in ("experimental file", "stable file")]))
md.append("\nRecords by node marking (node or an ancestor carries x-status: experimental):\n")
md.append(table(["surface", "non-add rec", "additive rec", "annot. rec"],
                [[k, ex[(k, "non-additive")], ex[(k, "additive")], ex[(k, "annotation")]]
                 for k in ("exp-marked node", "stable node")]))
for l in LAYERS:
    g = by_layer[l]
    if not g:
        continue
    e = [r for r in g if r["exp_file"]]
    summary["experimental"][f"layer:{l}"] = {"file_changes": len(g), "exp_file_changes": len(e),
                                             "nonadd": sum(r["cls"] == "non-additive" for r in g),
                                             "exp_nonadd": sum(r["cls"] == "non-additive" for r in e)}
md.append("\nExperimental-file share by layer:\n")
md.append(table(["layer", "file changes", "on experimental files", "non-add fc", "non-add on experimental files"],
                [[l, v["file_changes"], v["exp_file_changes"], v["nonadd"], v["exp_nonadd"]]
                 for l, v in ((k.split(":")[1], v) for k, v in summary["experimental"].items()
                              if k.startswith("layer:"))]))

exp_now_files = sum(1 for v in meta["experimental_now"].values() if v["file_exp"])
md.append(f"\nSchema files at head: {len(meta['tree'])}; with schema-level x-status experimental: {exp_now_files}.\n")
ew = []
summary["experimental_by_window"] = {}
for w_ in WINDOWS:
    g = [r for r in rows if r["window"] == w_]
    e = [r for r in g if r["exp_file"]]
    d = {"file_changes": len(g), "exp_file_changes": len(e),
         "nonadd": sum(r["cls"] == "non-additive" for r in g),
         "exp_nonadd": sum(r["cls"] == "non-additive" for r in e),
         "files": len({r["cur"] for r in g}), "exp_files": len({r["cur"] for r in e})}
    summary["experimental_by_window"][w_] = d
    ew.append([w_, d["file_changes"], f"{d['exp_file_changes']} ({pct(d['exp_file_changes'], d['file_changes'])})",
               d["nonadd"], f"{d['exp_nonadd']} ({pct(d['exp_nonadd'], d['nonadd'])})",
               d["files"], d["exp_files"]])
md.append(table(["window", "file changes", "on experimental files", "non-add fc", "non-add on exp. files",
                 "distinct files", "distinct exp. files"], ew))
summary["experimental_files_now"] = exp_now_files

with open(os.path.join(args.out, "unplaced.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["path", "module", "how"])
    w.writerows(unplaced_paths)
summary["unplaced_paths"] = len(unplaced_paths)
md.append(f"\n## Placement fallbacks\n\n{len(unplaced_paths)} historical paths were not in the placement file "
          f"after following renames; see unplaced.csv. Sources: " +
          ", ".join(f"{k} {v}" for k, v in Counter(h for _, _, h in unplaced_paths).items()) + ".\n")

open(os.path.join(args.out, "report.md"), "w").write("\n".join(md) + "\n")
json.dump(summary, open(os.path.join(args.out, "summary.json"), "w"), indent=1, default=str)
print(f"wrote {args.out}/report.md")
