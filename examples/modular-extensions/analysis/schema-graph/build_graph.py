"""Build the $ref dependency graph of AdCP static/schemas/source.

Usage: python3 -I build_graph.py <schemas/source dir> <out dir>

Outputs (in out dir):
  nodes.json          per-file: module, x-status experimental pointers, refs out
  edges.csv           file-level edges (src,dst)
  module_edges.csv    module-level edge counts (dir level)
  experimental.json   every x-status: experimental location + classification
  summary.json        headline numbers
"""
import json
import os
import sys
import posixpath
from collections import defaultdict

SRC = sys.argv[1]
OUT = sys.argv[2]

ROOT_FILES = {
    "adagents.json": "adagents",
    "brand.json": "brand",
    "index.json": "_registry",
    "manifest.schema.json": "_registry",
}


def module_of(rel):
    parts = rel.split("/")
    if len(parts) == 1:
        return ROOT_FILES.get(rel, "_root")
    return parts[0]


files = {}
for dp, _, fns in os.walk(SRC):
    for fn in fns:
        if fn.endswith(".json"):
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, SRC).replace(os.sep, "/")
            with open(full) as fh:
                files[rel] = json.load(fh)


def resolve(ref, src_rel):
    target = ref.split("#", 1)[0]
    if not target:
        return None  # internal ref
    if target.startswith("/schemas/"):
        return target[len("/schemas/"):]
    if target.startswith("http"):
        # absolute URL into published versions: /schemas/<ver>/path
        p = target.split("/schemas/", 1)[1]
        return p.split("/", 1)[1]
    return posixpath.normpath(posixpath.join(posixpath.dirname(src_rel), target))


edges = set()
ref_ptrs = defaultdict(list)  # (src,dst) -> json pointers where ref appears
exp = []  # experimental markers
dangling = []


def walk(node, rel, ptr, in_exp_ptr):
    if isinstance(node, dict):
        here_exp = in_exp_ptr
        if node.get("x-status") == "experimental":
            exp.append({"file": rel, "ptr": ptr or "/"})
            here_exp = ptr or "/"
        r = node.get("$ref")
        if isinstance(r, str):
            dst = resolve(r, rel)
            if dst:
                if dst not in files:
                    dangling.append((rel, r))
                elif dst != rel:
                    edges.add((rel, dst))
                    ref_ptrs[(rel, dst)].append({"ptr": ptr or "/", "under_experimental": here_exp})
        for k, v in node.items():
            walk(v, rel, f"{ptr}/{k}", here_exp)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, rel, f"{ptr}/{i}", in_exp_ptr)


for rel, doc in files.items():
    if rel in ("index.json",):
        continue  # registry: refs everything, not a type dependency
    walk(doc, rel, "", None)

# file-level experimental status
file_exp = {rel: bool(isinstance(d, dict) and d.get("x-status") == "experimental") for rel, d in files.items()}

nodes = {}
out_adj = defaultdict(set)
in_adj = defaultdict(set)
for s, d in edges:
    out_adj[s].add(d)
    in_adj[d].add(s)
for rel in files:
    nodes[rel] = {
        "module": module_of(rel),
        "file_experimental": file_exp[rel],
        "out": sorted(out_adj[rel]),
        "in": sorted(in_adj[rel]),
    }

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "nodes.json"), "w") as fh:
    json.dump(nodes, fh, indent=1)
with open(os.path.join(OUT, "edges.csv"), "w") as fh:
    fh.write("src,dst,src_module,dst_module\n")
    for s, d in sorted(edges):
        fh.write(f"{s},{d},{module_of(s)},{module_of(d)}\n")
with open(os.path.join(OUT, "ref_ptrs.json"), "w") as fh:
    json.dump({f"{s} -> {d}": v for (s, d), v in sorted(ref_ptrs.items())}, fh, indent=1)
with open(os.path.join(OUT, "experimental_raw.json"), "w") as fh:
    json.dump(exp, fh, indent=1)
with open(os.path.join(OUT, "dangling.json"), "w") as fh:
    json.dump(dangling, fh, indent=1)
print(f"files={len(files)} edges={len(edges)} exp_markers={len(exp)} dangling={len(dangling)}")
