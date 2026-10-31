"""Classify every x-status: experimental marker as isolated vs entangled.

Usage: python3 -I analyze_experimental.py <schemas/source dir> <raw dir>
Writes raw/experimental.json and prints a summary.
"""
import json
import os
import sys
from collections import Counter, defaultdict

SRC, RAW = sys.argv[1], sys.argv[2]
nodes = json.load(open(os.path.join(RAW, "nodes.json")))
exp = json.load(open(os.path.join(RAW, "experimental_raw.json")))
ref_ptrs = json.load(open(os.path.join(RAW, "ref_ptrs.json")))

file_exp = {f for f, n in nodes.items() if n["file_experimental"]}

# map dst -> list of (src, ptr, under_experimental)
incoming = defaultdict(list)
for key, lst in ref_ptrs.items():
    s, d = key.split(" -> ")
    for r in lst:
        incoming[d].append((s, r["ptr"], r["under_experimental"]))


def get(doc, ptr):
    cur = doc
    for p in ptr.strip("/").split("/") if ptr != "/" else []:
        cur = cur[int(p)] if isinstance(cur, list) else cur[p]
    return cur


def is_task_payload(f):
    b = os.path.basename(f)
    return b.endswith("-request.json") or b.endswith("-response.json") or "webhook" in b


rows = []
for e in exp:
    f, ptr = e["file"], e["ptr"]
    rec = {"file": f, "module": nodes[f]["module"], "ptr": ptr}
    if ptr == "/":
        rec["kind"] = "schema"
        # who references this experimental schema from a stable context?
        stable_refs = []
        for s, rptr, under in incoming[f]:
            if s in file_exp or under:
                continue
            stable_refs.append(f"{s}#{rptr}")
        rec["stable_referrers"] = stable_refs
        rec["class"] = "entangled-ref" if stable_refs else "isolated"
    else:
        # is this marker nested inside an already-experimental ancestor in same file?
        ancestors = [x["ptr"] for x in exp if x["file"] == f and x["ptr"] != ptr
                     and (x["ptr"] == "/" or ptr.startswith(x["ptr"] + "/"))]
        node = get(json.load(open(os.path.join(SRC, f))), ptr)
        rec["kind"] = "property" if "/properties/" in ptr else ("enum-or-branch" if any(k in ptr for k in ("/oneOf/", "/anyOf/", "/enum")) else "other")
        rec["is_ref"] = isinstance(node, dict) and "$ref" in node
        rec["nested_in_experimental"] = bool(ancestors)
        if ancestors:
            rec["class"] = "nested"
        elif f in file_exp:
            rec["class"] = "nested"
        else:
            rec["class"] = "entangled-inline"
        rec["host_is_task_payload"] = is_task_payload(f)
    rows.append(rec)

json.dump(rows, open(os.path.join(RAW, "experimental.json"), "w"), indent=1)

print("total markers:", len(rows))
print("by kind:", Counter(r["kind"] for r in rows))
print("by class:", Counter(r["class"] for r in rows))
print("by module x class:")
for (m, c), n in sorted(Counter((r["module"], r["class"]) for r in rows).items()):
    print(f"  {m:24s} {c:18s} {n}")
inline = [r for r in rows if r["class"] == "entangled-inline"]
hosts = Counter(r["file"] for r in inline)
print("stable host files with inline experimental fields:", len(hosts))
print("  of which task payloads (req/resp/webhook):", sum(1 for h in hosts if is_task_payload(h)))
for h, n in hosts.most_common(40):
    print(f"   {n:3d} {h}")
print("inline experimental that are $ref (cheap to lift):", sum(1 for r in inline if r.get("is_ref")))
ent = [r for r in rows if r["class"] == "entangled-ref"]
print("experimental schema files:", sum(1 for r in rows if r["kind"] == "schema"),
      "isolated:", sum(1 for r in rows if r["kind"] == "schema" and r["class"] == "isolated"),
      "entangled-ref:", len(ent))
for r in ent:
    print("  ", r["file"], "<-", r["stable_referrers"][:4], ("+%d" % (len(r["stable_referrers"]) - 4)) if len(r["stable_referrers"]) > 4 else "")
