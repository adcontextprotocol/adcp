"""Shared loader for the module cut: per-commit file changes resolved to current paths and labels.

Mirrors churn/aggregate.py: follows renames, places deleted paths by their last referrers
(ignoring assembly referrers), then by a directory heuristic. Stdlib only.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MM = os.path.dirname(HERE)
CHURN_RAW = os.path.join(MM, "churn", "raw")
CUT2 = os.path.join(MM, "kernel-cut", "raw")
CAPS = "protocol/get-adcp-capabilities-response.json"
KERNEL_LABELS = {"kernel", "kernel-types"}


def load_json(p):
    with open(p) as fh:
        return json.load(fh)


def labels_of(placement_path):
    return {p: (v["label"] if isinstance(v, dict) else v) for p, v in load_json(placement_path).items()}


def layer_of(label):
    if label in KERNEL_LABELS or label.startswith("kernel"):
        return "kernel"
    if label == "assembly" or label.startswith("_"):
        return "assembly"
    if label.startswith("extension:"):
        return "extension"
    if label in ("retire", "unplaced"):
        return label
    return "module"


class History:
    """Raw churn history. `resolve(path, placement)` gives the label of a historical path."""

    def __init__(self, raw=CHURN_RAW):
        self.meta = load_json(os.path.join(raw, "meta.json"))
        with open(os.path.join(raw, "commits.jsonl")) as fh:
            self.commits = {c["sha"]: c for c in map(json.loads, fh)}
        with open(os.path.join(raw, "file_changes.jsonl")) as fh:
            self.fcs = [json.loads(line) for line in fh]
        self.fwd = {}
        for _sha, old, new in load_json(os.path.join(raw, "renames.json")):
            self.fwd[old] = new
        self.deleted_refs = {fc["old"]: fc["referrers"] for fc in self.fcs
                             if fc["status"] == "D" and fc.get("referrers") is not None}
        self.dir_heur = [tuple(x) for x in load_json(os.path.join(MM, "churn", "placements",
                                                                    "cut-29-dir-heuristic.json"))]

    def current(self, p):
        seen = set()
        while p in self.fwd and p not in seen:
            seen.add(p)
            p = self.fwd[p]
        return p

    def resolver(self, labels, dir_heur=None):
        cache = {}
        dh = dir_heur if dir_heur is not None else self.dir_heur

        def module_of(path, depth=0):
            if path in cache:
                return cache[path]
            cur = self.current(path)
            res = None
            if cur in labels:
                res = labels[cur]
            else:
                refs = [r for r in self.deleted_refs.get(path, []) if r != "index.json"]
                if refs and depth < 4:
                    mods = {module_of(r, depth + 1) for r in refs} - {"unplaced"}
                    mods = {m for m in mods if layer_of(m) != "assembly"}
                    if len(mods) == 1:
                        res = mods.pop()
                if res is None:
                    for prefix, m in dh:
                        if path.startswith(prefix):
                            res = m
                            break
                if res is None:
                    res = "unplaced"
            cache[path] = res
            return res
        return module_of

    def rows(self):
        """Yield (commit, file change, historical path, current path, class) excluding the bootstrap commit."""
        for fc in self.fcs:
            c = self.commits[fc["sha"]]
            if c["bootstrap"]:
                continue
            path = fc["new"] or fc["old"]
            if fc["n_nonadditive"]:
                cls = "non-additive"
            elif fc["n_additive"]:
                cls = "additive"
            elif fc["n_annotation"]:
                cls = "annotation"
            else:
                cls = "no-op"
            yield c, fc, path, self.current(path), cls


def caps_owner_map(caps_json):
    """caps2.json -> ({path: owner}, default owner)."""
    co = load_json(caps_json)
    m = {}
    for owner, info in co["owners"].items():
        for pth in info.get("paths", []):
            m[pth.replace(" (block shell)", "")] = owner
    default = m.get("adcp", "kernel")
    m["#root"] = default
    m["#definitions"] = default
    return m, default


def caps_owners_of_fc(fc, cmap, default, classes=("additive", "non-additive")):
    out = set()
    for rec in fc["records"]:
        if rec["cls"] not in classes:
            continue
        ptr = rec["ptr"]
        parts = [p.replace("~1", "/").replace("~0", "~") for p in ptr.strip("/").split("/")]
        if len(parts) >= 2 and parts[0] == "properties":
            if len(parts) >= 4 and parts[2] == "properties" and f"{parts[1]}.{parts[3]}" in cmap:
                out.add(cmap[f"{parts[1]}.{parts[3]}"])
            else:
                out.add(cmap.get(parts[1], default))
            continue
        owners = {cmap.get(b, default) for b in (rec.get("caps_blocks") or ["#root"])}
        if len(owners) > 1:
            owners.discard(default)
        out |= owners
    return out


def commit_label_sets(hist, labels, cmap, default, substantive=True, window_filter=None):
    """{sha: {"labels": set of non-retire labels incl. caps fragments, "files": set of current paths}}."""
    module_of = hist.resolver(labels)
    out = {}
    for c, fc, path, cur, cls in hist.rows():
        if window_filter and not window_filter(c):
            continue
        if substantive and cls in ("annotation", "no-op"):
            continue
        if fc["old"] and fc["new"] and fc["old"] != fc["new"]:
            lab = module_of(fc["new"])
        else:
            lab = module_of(path)
        d = out.setdefault(c["sha"], {"labels": set(), "files": set(), "na_labels": set()})
        if lab == "retire":
            continue
        if cur == CAPS:
            d["labels"] |= caps_owners_of_fc(fc, cmap, default)
            d["na_labels"] |= caps_owners_of_fc(fc, cmap, default, ("non-additive",))
            continue
        if layer_of(lab) == "assembly":
            continue
        d["labels"].add(lab)
        d["files"].add(cur)
        if cls == "non-additive":
            d["na_labels"].add(lab)
    return out
