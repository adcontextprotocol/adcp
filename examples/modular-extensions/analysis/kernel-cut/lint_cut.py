"""Lint the kernel/module/extension cut against a schema tree.

Usage: python3 -I lint_cut.py <schemas/source dir> <raw dir> [--baseline raw/lint_baseline.json] [--write-baseline]

Inputs: <raw>/placement2.json (file -> label), <raw>/dag2.json (label -> declared deps).
In the real repo these would be a per-module manifest (module.json: name, version, depends_on,
extension_points) and an `x-adcp-module` annotation or module directory; this script reads the
cut-2 files instead. It rebuilds the $ref graph from the tree, so it catches new edges.

Rules (each violation is printed as RULE src -> dst):
  L1 kernel-closed      kernel / kernel-types files $ref only kernel / kernel-types
  L2 declared-deps      a module file $refs only kernel, kernel-types, its own module, or a module in
                        the transitive closure of its declared depends_on
  L3 no-ext-inbound     nothing except another file of the same extension $refs an extension file
  L4 ext-attach         an extension file $refs only kernel, kernel-types, modules, or itself
  L5 acyclic            the module graph built from actual edges has no cycle
  L6 kernel-stable      no x-status: experimental anywhere in kernel / kernel-types files
  L7 unplaced           every schema file has a label (new files must be placed)
Violations listed in the baseline are reported but do not fail (ratchet: the baseline may only shrink).
"""
import json
import os
import posixpath
import sys

SRC, RAW = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
base_path = args[args.index("--baseline") + 1] if "--baseline" in args else os.path.join(RAW, "lint_baseline.json")
place = {f: v["label"] for f, v in json.load(open(os.path.join(RAW, "placement2.json"))).items()}
dag = json.load(open(os.path.join(RAW, "dag2.json")))
KL = {"kernel", "kernel-types"}


def closure(m, cache={}):
    if m not in cache:
        s = {m} | KL
        for d in dag.get(m, []):
            s |= closure(d)
        cache[m] = s
    return cache[m]


def resolve(ref, src):
    t = ref.split("#", 1)[0]
    if not t:
        return None
    if t.startswith("/schemas/"):
        return t[len("/schemas/"):]
    if t.startswith("http"):
        return t.split("/schemas/", 1)[1].split("/", 1)[1]
    return posixpath.normpath(posixpath.join(posixpath.dirname(src), t))


files, edges, exp_in_kernel = {}, set(), []


def walk(n, f, ptr=""):
    if isinstance(n, dict):
        if n.get("x-status") == "experimental" and place.get(f) in KL:
            exp_in_kernel.append(f"{f}#{ptr or '/'}")
        r = n.get("$ref")
        if isinstance(r, str):
            d = resolve(r, f)
            if d and d != f:
                edges.add((f, d))
        for k, v in n.items():
            walk(v, f, f"{ptr}/{k}")
    elif isinstance(n, list):
        for i, v in enumerate(n):
            walk(v, f, f"{ptr}/{i}")


for dp, _, fns in os.walk(SRC):
    for fn in fns:
        if fn.endswith(".json"):
            rel = os.path.relpath(os.path.join(dp, fn), SRC).replace(os.sep, "/")
            files[rel] = json.load(open(os.path.join(dp, fn)))
for f, doc in files.items():
    if f != "index.json":
        walk(doc, f)

viol = []
for f in sorted(files):
    if f not in place:
        viol.append(("L7", f, "-"))
for s, d in sorted(edges):
    a, b = place.get(s), place.get(d)
    if a is None or b is None or a in ("assembly", "retire"):
        continue
    if a in KL and b not in KL:
        viol.append(("L1", s, d))
    elif a.startswith("module:") and b not in closure(a):
        viol.append(("L3" if b.startswith("extension:") else "L2", s, d))
    elif a.startswith("extension:") and (b.startswith("extension:") and b != a or b in ("assembly", "retire")):
        viol.append(("L4", s, d))
for x in exp_in_kernel:
    viol.append(("L6", x, "-"))

# L5: cycles over actual label edges
adj = {}
for s, d in edges:
    a, b = place.get(s), place.get(d)
    if a and b and a != b and a not in ("assembly", "retire") and not a.startswith("kernel"):
        adj.setdefault(a, set()).add(b)
seen, stack, cycles = {}, [], []


def dfs(v):
    seen[v] = 1
    stack.append(v)
    for w in sorted(adj.get(v, ())):
        if seen.get(w) == 1:
            cycles.append(stack[stack.index(w):] + [w])
        elif not seen.get(w):
            dfs(w)
    stack.pop()
    seen[v] = 2


for v in sorted(adj):
    if not seen.get(v):
        dfs(v)
for c in cycles:
    viol.append(("L5", " -> ".join(c), "-"))

keys = [f"{r} {s} -> {d}" for r, s, d in viol]
if "--write-baseline" in args:
    json.dump(sorted(keys), open(base_path, "w"), indent=1)
    print(f"wrote baseline with {len(keys)} entries to {base_path}")
    sys.exit(0)
baseline = set(json.load(open(base_path))) if os.path.exists(base_path) else set()
new = [k for k in keys if k not in baseline]
fixed = sorted(baseline - set(keys))
by_rule = {}
for r, _, _ in viol:
    by_rule[r] = by_rule.get(r, 0) + 1
print(f"files={len(files)} edges={len(edges)} violations={len(keys)} by rule={by_rule} baselined={len(keys) - len(new)}")
for k in new:
    print("NEW", k)
for k in fixed:
    print("FIXED (remove from baseline)", k)
sys.exit(1 if new else 0)
