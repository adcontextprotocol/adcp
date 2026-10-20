"""Final layout step 6: table data for the final layout.

Usage: python3 -I -B report_final.py
Reads raw/placement-final.json, raw/edges.csv, raw/crossing-edges.csv, raw/verify-final.json, raw/metrics-*.json,
      inputs/star-placement.json, churn/raw (REF 45591e97b3) for kernel-layer churn.
Writes raw/tables-final.json and raw/report-final.md:
  file counts per module, layer, and extension; kernel-layer moves with post-GA churn;
  kernel reference types each module uses that point into another module (today and after the fixes);
  4.0 $id namespaces: how many $ids change, and basename collisions inside a namespace.
"""
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common_final import BRIDGES, CHURN, INPUTS, ORDER, RAW, SFX, V1_BRIDGES, dump, load, module_of  # noqa: E402

place = load(os.path.join(RAW, f"placement-final{SFX}.json"))
lab = {f: v["label"] for f, v in place.items()}
edges = list(csv.DictReader(open(os.path.join(RAW, "edges.csv"))))
cross = list(csv.DictReader(open(os.path.join(RAW, f"crossing-edges{SFX}.csv"))))
star = load(os.path.join(INPUTS, "star-placement.json"))
cut10 = {f: (v.get("cut_10") or v["label"]) for f, v in star.items()}
for f in place:
    cut10.setdefault(f, place[f]["label"])


def unit(l):
    if l.startswith("module:buying/"):
        return "buying"
    return module_of(l) or l


# ---------------------------------------------------------------- counts
counts = Counter(unit(l) for l in lab.values())
layer_counts = {l: sum(1 for x in lab.values() if x == f"module:buying/{l}") for l in ORDER}
ext_counts = Counter(l.split(":", 1)[1] for l in lab.values() if l.startswith("extension:"))

# ---------------------------------------------------------------- kernel-layer moves and their churn
commits = {c["sha"]: c for c in map(json.loads, open(os.path.join(CHURN, "raw", "commits.jsonl")))}
fwd = {o: n for _s, o, n in load(os.path.join(CHURN, "raw", "renames.json"))}


def cur(p):
    seen = set()
    while p in fwd and p not in seen:
        seen.add(p)
        p = fwd[p]
    return p


moved_k = sorted(f for f, l in lab.items() if l in ("kernel", "kernel-types") and cut10[f] not in ("kernel", "kernel-types"))
mods = defaultdict(lambda: {"mod": set(), "na": set()})
for line in open(os.path.join(CHURN, "raw", "file_changes.jsonl")):
    fc = json.loads(line)
    c = commits[fc["sha"]]
    if c["bootstrap"] or c["window"] == "pre-3.0" or not (fc["n_additive"] or fc["n_nonadditive"]):
        continue
    p = cur(fc["new"] or fc["old"])
    if p in moved_k and fc["status"] != "A":
        tag = f"#{c['pr']}" if c.get("pr") else c["sha"][:10]
        mods[p]["mod"].add(tag)
        if fc["n_nonadditive"]:
            mods[p]["na"].add(tag)
kernel_moves = {f: {"from": cut10[f], "to": lab[f], "post_ga_mod": sorted(mods[f]["mod"]), "post_ga_na": sorted(mods[f]["na"])}
                for f in moved_k}

# ---------------------------------------------------------------- reference types between modules
OWNER = {  # kernel reference type -> module whose objects it points at (None: no owner)
    "account-ref": "accounts", "canonical-account-ref": "accounts", "brand-ref": "identity", "brand-id": "identity",
    "brand-key": "identity", "attestation-reference": "identity", "signal-ref": "signals", "signal-id": "signals",
    "activation-key": "signals", "format-id": "creative", "format-option-ref": "creative", "property-id": "buying",
    "property-tag": "buying", "placement-ref": "buying", "placement-identity": "buying", "collection-ref": "buying",
    "collection-selector": "buying", "installment-ref": "buying", "acceptance-policy-profile-ref": "buying",
    "property-list-ref": "governance", "collection-list-ref": "governance", "seller-agent-ref": None,
    "vendor-metric-id": None, "locale-tag": None}
if SFX:  # v2: the acceptance-policy files belong to governance
    OWNER["acceptance-policy-profile-ref"] = "governance"
NAME = {"canonical-account-ref": "account_ref", "brand-id": "brand_ref", "brand-key": "brand_ref",
        "attestation-reference": "attestation_ref", "signal-id": "signal_ref", "seller-agent-ref": "agent_ref",
        "placement-identity": "placement_ref", "collection-selector": "collection_ref"}
NEW_OWNER = {"account_ref": "accounts", "creative_ref": "creative", "catalog_ref": "buying",
             "format_option_ref": "creative", "format_kind_id": "creative", "asset_type_id": "identity",
             "indicator_type_id": "creative", "indicator": None, "media_asset": None, "metric_id": None,
             "metric_value": None, "right_type_id": "identity", "right_use_id": "identity", "property_id": "buying",
             "signal_ref": "signals", "acceptance_policy_profile_ref": "governance" if SFX else "buying", "forecast_range + metric_id": None,
             "media_buy_ref": "buying", "proposal_ref": "buying", "artifact_ref": "governance"}
BRIDGE_IDS = {k: [i for i in v[3] if i.endswith(("_ref", "_id"))] for k, v in BRIDGES.items()}
today = defaultdict(set)
for e in edges:
    m = unit(lab[e["src"]])
    n = e["dst"].split("/")[-1][:-5]
    if lab[e["dst"]] == "kernel-types" and OWNER.get(n) not in (None, m):
        today[m].add(NAME.get(n, n.replace("-", "_")))
after = defaultdict(set)
bridges_by_module = defaultdict(set)
for r in cross:
    m = unit(r["src_label"])
    fx = r["fix"].split(":")[0]
    if r["fix_class"] in ("b", "a-split") and NEW_OWNER.get(fx, "x") != m:
        after[m].add(fx.replace("forecast_range + ", ""))
    if r["fix_class"] == "c":
        bid = fx.split()[0].rstrip(":")
        bridges_by_module[m].add(bid)
        after[m] |= {i for i in BRIDGE_IDS[bid] if NEW_OWNER.get(i) != m}
for bid, (_n, decl, _o, _i) in BRIDGES.items():
    if not SFX and bid not in V1_BRIDGES:
        continue
    for m in [decl]:
        bridges_by_module[m].add(bid)
        after[m] |= {i for i in BRIDGE_IDS[bid] if NEW_OWNER.get(i) != m}
ids = {m: {"today": sorted(today[m]), "added_by_fixes": sorted(after[m] - today[m]),
           "bridges": sorted(bridges_by_module[m])} for m in sorted(set(today) | set(after))}

# ---------------------------------------------------------------- 4.0 $id namespaces
def new_path(f, l):
    base = f.split("/")[-1]
    if l in ("kernel", "kernel-types"):  # the kernel layer keeps core/, enums/, protocol/, error-details/
        return f if f.split("/")[0] in ("core", "enums", "protocol", "error-details", "extensions") else f"core/{base}"
    if l == "assembly":
        return f
    if l == "retire":
        return None
    if l.startswith("extension:"):
        return f"extensions/{l.split(':', 1)[1]}/{base}"
    if l.startswith("module:buying/"):
        return f"buying/{l.split('/', 1)[1]}/{base}"
    if l.startswith("module:"):
        sub = f.split("/")[0]
        if sub in ("core", "enums", "error-details", "media-buy", "protocol"):
            return f"{l[7:]}/{base}"
        return f  # already in a module directory (creative/, governance/, brand/, ...)
    return f


np_ = {f: new_path(f, l) for f, l in lab.items()}
changed = sorted(f for f, n in np_.items() if n and n != f)
coll = defaultdict(list)
for f, n in np_.items():
    if n:
        coll[n].append(f)
collisions = {n: fs for n, fs in coll.items() if len(fs) > 1}
retired = sorted(f for f, n in np_.items() if n is None)

v = load(os.path.join(RAW, f"verify-final{SFX}.json"))
tables = {"counts": dict(counts.most_common()), "layer_counts": layer_counts, "extension_counts": dict(ext_counts),
          "kernel_layer_files": counts["kernel"] + counts["kernel-types"],
          "kernel_moves": kernel_moves, "kernel_moves_n": len(kernel_moves),
          "kernel_moves_modified_post_ga": sum(1 for x in kernel_moves.values() if x["post_ga_mod"]),
          "kernel_moves_nonadditive": {f: x["post_ga_na"] for f, x in kernel_moves.items() if x["post_ga_na"]},
          "ids": ids, "id_changes_40": len(changed),
          "id_changes_40_by_unit": dict(Counter(unit(lab[f]) for f in changed).most_common()), "namespace_collisions": collisions, "retired": retired,
          "verify": {k: v[k] for k in ("crossing_occurrences", "crossing_file_edges", "star_violations_today",
                                      "layer_violations_today", "star_violations_after", "cycles_after")}}
dump(tables, os.path.join(RAW, f"tables-final{SFX}.json"))
md = ["# Final layout tables (generated by report_final.py)", "",
      f"Kernel layer: {tables['kernel_layer_files']} files ({counts['kernel']} kernel, {counts['kernel-types']} kernel types); "
      f"{len(kernel_moves)} moved in, {tables['kernel_moves_modified_post_ga']} modified after GA.", "",
      "| unit | files |", "|---|---|"] + [f"| {k} | {n} |" for k, n in counts.most_common()] + [
      "", "| buying layer | files |", "|---|---|"] + [f"| {k} | {n} |" for k, n in layer_counts.items()] + [
      "", "| module | ids into other modules today | ids added by the fixes | bridges |", "|---|---|---|---|"] + [
      f"| {m} | {', '.join(x['today']) or '-'} | {', '.join(x['added_by_fixes']) or '-'} | {', '.join(x['bridges']) or '-'} |"
      for m, x in ids.items()] + ["", f"4.0 $id changes: {len(changed)}; collisions: {len(collisions)}; retired: {len(retired)}"]
for n, fs in sorted(collisions.items()):
    md.append(f"- `{n}` <- {', '.join(fs)}")
with open(os.path.join(RAW, f"report-final{SFX}.md"), "w") as fh:
    fh.write("\n".join(md) + "\n")
print("\n".join(md))
