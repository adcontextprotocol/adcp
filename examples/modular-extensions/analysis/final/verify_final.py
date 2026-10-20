"""Final layout step 3: verify the placement. Three checks, each with an explicit fix for every edge it flags.

Usage: python3 -I -B verify_final.py
Reads raw/placement-final.json, raw/edges.csv, inputs/star_decisions.py (the star analysis's per-edge classes).
Writes raw/crossing-edges.csv   every $ref occurrence that crosses a forbidden boundary today, with its fix
       raw/verify-final.json    counts before and after the fixes, unresolved edges, cycles, per-module ids
With FINAL_TAG=v2 it reads raw/placement-final-v2.json, applies the byte-preserving fixes of the wire analysis
(V2_RULES) first, and writes raw/crossing-edges-v2.csv and raw/verify-final-v2.json.

Checks
  1. Star: a standard module or the compliance-testing leaf $refs only the kernel layer (kernel + kernel
     types), its own files, generated assembly files, and extensions at the extension points it declares.
     Kernel-layer files $ref no module. An extension $refs only the kernel layer and the modules it connects.
  2. Layers: a buying layer $refs only the kernel layer, its own layer, and the layers in DEPS
     (offer and execution are siblings; pricing and catalogs are siblings).
  3. Acyclic: the unit graph (kernel layer, each module, each buying layer, each extension) has no cycle.

Each check runs twice: "today" (every $ref in the current tree, under the final placement) and "after"
(edges whose fix replaces the $ref by a kernel id, an extension point, a kernel split, or a definition move
are removed). An edge with no fix is "unresolved"; the target is 0.
"""
import csv
import os
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common_final import (BRIDGE_ENDS, BRIDGE_NAMES, DEPS, INPUTS, ORDER, RAW, SFX, TAG, bridge_id, dump,  # noqa: E402
                          is_kernel, layer_of, load, module_of)

sys.path.insert(0, INPUTS)
import star_decisions as D  # noqa: E402

place = {f: v["label"] for f, v in load(os.path.join(RAW, f"placement-final{SFX}.json")).items()}
edges = list(csv.DictReader(open(os.path.join(RAW, "edges.csv"))))

EXT_BY_NAME = {v: k for k, v in BRIDGE_NAMES.items()}
# Extensions that existed before the star analysis and the module whose extension point each one fills.
OTHER_EXT_ENDS = {"response-signing-jws": {"identity"}, "spot-lifecycle": {"buying"},
                  "adcp-ext-namespace": {"buying"}, "aao-verification-token": set()}

RELEASE = {  # what each fix class does in 3.4 (additive) and in 4.0 (breaking once)
    "a": ("3.4 kernel-type copy with alias", "4.0 delete old $id"),
    "a-split": ("3.4 publish the kernel open id or core next to the module's list", "4.0 retype the field"),
    "b": ("3.4 add the id field beside the embedded object", "4.0 remove the embedded object"),
    "c": ("3.4 annotate the host property as an extension point", "4.0 move the property into the bridge"),
    "e": ("3.4 publish the definition in its owner with an alias", "4.0 delete the old definition"),
    "x": ("3.4 annotate the host property as an extension point", "4.0 move the property into the extension"),
}

# Wrong-way patterns between buying layers (from the buying-layers analysis), keyed by (src, dst).
WRONG_WAY_FIX = {
    ("media-buy/get-media-buys-response.json", "core/canonical-proposal.json"):
        ("W1", "accepted_terms_ref (proposal_id, terms_digest) replaces accepted_proposal",
         "3.4 add accepted_terms_ref", "4.0 drop accepted_proposal"),
    ("media-buy/media-buy-commitment-response.json", "core/canonical-proposal.json"):
        ("W1", "accepted_terms_ref (proposal_id, terms_digest) replaces accepted_proposal",
         "3.4 add accepted_terms_ref", "4.0 drop accepted_proposal"),
    ("media-buy/accept-proposal-response.json", "media-buy/media-buy-commitment-response.json"):
        ("W1", "accept response composes a commitment-layer commit-response base (accepted_terms_ref, "
               "purchase_bindings), not execution's response",
         "3.4 publish commit-response base in commitment", "4.0 accept response stops composing execution's"),
    ("media-buy/create-media-buy-request.json", "core/opportunity-context.json"):
        ("W2", "opportunity_id replaces the embedded opportunity object", "3.4 deprecate opportunity",
         "4.0 drop opportunity"),
    ("media-buy/buy-products-request.json", "core/opportunity-context.json"):
        ("W2", "opportunity_id replaces the embedded opportunity object", "3.4 deprecate opportunity",
         "4.0 drop opportunity"),
    ("media-buy/get-products-response.json", "core/proposal.json"):
        ("W3", "get_products declares an extension point that offer fills (a kernel-cut fix)",
         "3.4 declare the extension point and deprecate proposals", "4.0 drop proposals from get_products"),
}


# v2 (the wire analysis): every fix keeps today's bytes. Rules keyed by (src module, dst) or (src, dst); checked first.
SLATED_FACADE = "removed with the 3.x compatibility facades (specs/legacy-compact-lifecycle-compatibility.md:11-13)"
V2_RULES = {
    ("buying", "core/account.json"): ("c", "C8", "buying declares media_buy.account; accounts fills it"),
    ("creative", "core/account.json"): ("c", "C9", "creative declares creatives[].account; accounts fills it"),
    ("creative", "core/delivery-metrics.json"): ("c", "C10", "creative declares the totals and variant metrics; "
                                                 "buying fills them with delivery-metrics"),
    ("trusted-match", "core/package-format-snapshot.json"): ("c", "C11", "TMP declares available_package."
                                                             "format_options[]; buying fills it"),
    ("trusted-match", "core/creative-manifest.json"): ("c", "C12", "TMP declares offer.creative_manifest; "
                                                       "creative fills it"),
    ("core/brand-ref.json", "core/assets/image-asset.json"): ("k", "media_asset", "brand_kit_override.logo "
                                                              "retyped to the kernel media_asset core"),
    ("media-buy/package-request.json", "core/creative-asset.json"): ("slated", "#6423", "inline package creatives "
                                                                    "removed in 4.0 (#6423, 4.0 milestone)"),
    ("media-buy/package-update.json", "core/creative-asset.json"): ("slated", "#6423", "inline package creatives "
                                                                   "removed in 4.0 (#6423, 4.0 milestone)"),
    ("core/product.json", "core/signal-listing.json"): ("slated", "facades", "legacy product signal listings; "
                                                        + SLATED_FACADE),
    ("core/product-signal-targeting-option.json", "core/signal-listing.json"): ("slated", "facades",
                                                                               "legacy product signal targeting "
                                                                               "options; " + SLATED_FACADE),
    ("media-buy/get-products-response.json", "core/proposal.json"): ("slated", "facades", "get_products proposals; "
                                                                     + SLATED_FACADE),
}
RELEASE_V2 = {
    "a-split": ("3.4: type the field with the kernel open id or core; the owner's registry keeps the known "
                "values (same bytes)", "-"),
    "c": ("3.4: extension point and bridge extension; the host schema is assembled from it (same bytes)", "-"),
    "e": ("3.4: definition published in its owner; the old $id aliases it (same bytes)", "-"),
    "k": ("3.4: retype to the kernel core (same bytes)", "-"),
    "x": ("3.4: annotate the host property as an extension point (same bytes)", "-"),
    "slated": ("-", "4.0: already slated removal"),
}


def v2_rule(src, dst, src_unit):
    for key in ((src, dst), (src_unit[7:] if src_unit.startswith("module:") else src_unit, dst)):
        if key in V2_RULES:
            return V2_RULES[key]
    return None


def ext_ends(name):
    """Modules an extension may $ref: both ends of a bridge, or the module an older extension extends."""
    if name in EXT_BY_NAME:
        declaring, other = BRIDGE_ENDS[EXT_BY_NAME[name]]
        return set(declaring) | {other}
    return OTHER_EXT_ENDS.get(name, set())


def unit(label):
    """Unit for the star and cycle checks: kernel layer, module, extension, assembly, retire."""
    if is_kernel(label):
        return "kernel"
    if label.startswith("module:"):
        return "module:" + module_of(label)
    return label


def star_rule(src, dst, src_unit):
    """The star analysis's class for a cross-module edge."""
    if src_unit == "module:compliance-testing":
        return ("e", None, "scenario fragment", "test-scenario params move into the owning module's scenario "
                "fragment; task-completion-data becomes a generated union")
    for key in ((src, dst), (src_unit, dst)):
        if key in D.EDGE:
            return D.EDGE[key]
        if key in D.INDUCED:
            return D.INDUCED[key]
    if src == "core/brand-ref.json" and dst == "core/assets/image-asset.json":
        return ("b", None, "media_asset", "kernel-cut fix: brand_kit_override.logo leaves brand-ref")
    return D.TARGET.get(dst)


rows = []
for e in edges:
    s, d = e["src"], e["dst"]
    a, b = place[s], place[d]
    ua, ub = unit(a), unit(b)
    rec = {"src": s, "dst": d, "src_label": a, "dst_label": b, "path": e["path"],
           "experimental": "Y" if e["under_experimental"] else ""}
    kind = None
    if ua in ("assembly", "retire") or ub == "assembly":
        continue  # the assembly is generated from everything; generated registries are referenced by id lists
    if ub == "retire":
        kind = "into-retired"
    elif ua == ub and ua == "module:buying":
        la, lb = layer_of(a), layer_of(b)
        if la != lb and lb not in DEPS[la]:
            kind = "layer"
    elif ua == ub:
        continue
    elif ua == "kernel" and ub != "kernel":
        kind = "kernel->module" if ub.startswith("module:") else "kernel->other"
    elif ua.startswith("module:") and ub.startswith("module:"):
        kind = "module->module"
    elif ua.startswith("module:") and ub.startswith("extension:"):
        kind = "module->extension"
    elif ua.startswith("extension:") and ub.startswith("module:"):
        if module_of(b) in ext_ends(ua.split(":", 1)[1]):
            continue  # an extension may $ref the modules it connects
        kind = "extension->foreign-module"
    elif ua.startswith("extension:") and ub.startswith("extension:"):
        kind = "extension->extension"
    else:
        continue  # module/extension -> kernel layer is the allowed direction
    if kind is None:
        continue
    rec["check"] = kind
    fix = {"fix_class": "", "fix": "", "release_34": "", "release_40": "", "source": "", "resolved": ""}
    if kind == "layer" and TAG == "v2":
        r2 = v2_rule(s, d, ua)
        if r2:
            fix.update(fix_class=r2[0], fix=f"{r2[1]}: {r2[2]}", release_34=RELEASE_V2[r2[0]][0],
                       release_40=RELEASE_V2[r2[0]][1], source="wire-analysis", resolved="Y")
    elif kind == "layer":
        ww = WRONG_WAY_FIX.get((s, d))
        if ww:
            fix.update(fix_class=ww[0], fix=ww[1], release_34=ww[2], release_40=ww[3], source="buying-layers",
                       resolved="Y")
    elif kind == "module->extension":
        name = ub.split(":", 1)[1]
        if name in EXT_BY_NAME:
            bid = EXT_BY_NAME[name]
            ok = module_of(a) in BRIDGE_ENDS[bid][0]
            rc = RELEASE_V2["c"] if TAG == "v2" else RELEASE["c"]
            fix.update(fix_class="c", fix=f"{bid} {name}",
                       release_34=rc[0], release_40=rc[1], source="star",
                       resolved="Y" if ok else "")
        elif module_of(a) in OTHER_EXT_ENDS.get(name, set()):
            rx = RELEASE_V2["x"] if TAG == "v2" else RELEASE["x"]
            fix.update(fix_class="x", fix=f"extension point filled by {name}", release_34=rx[0],
                       release_40=rx[1], source="buying-layers" if name == "spot-lifecycle" else "kernel-cut",
                       resolved="Y")
    elif kind in ("module->module", "kernel->module") and TAG == "v2" and v2_rule(s, d, ua):
        cls, ref, note = v2_rule(s, d, ua)
        label = f"{ref} {BRIDGE_NAMES[ref]}" if cls == "c" else ref
        if cls == "c":
            assert module_of(a) in BRIDGE_ENDS[ref][0] and module_of(b) == BRIDGE_ENDS[ref][1], (s, d, ref)
        fix.update(fix_class=cls, fix=f"{label}: {note}", release_34=RELEASE_V2[cls][0],
                   release_40=RELEASE_V2[cls][1], source="wire-analysis", resolved="Y")
    elif kind in ("module->module", "kernel->module"):
        r = star_rule(s, d, ua)
        if r:
            cls, dest, idt, note = r
            # resolved if the $ref is replaced (b, c, a-split) or the referring definition moves (e, dest None)
            ok = cls in ("b", "c", "a-split") or (cls == "e" and dest is None)
            if cls == "c":
                idt = bridge_id(idt, module_of(a))
                idt = f"{idt} {BRIDGE_NAMES[idt]}"
                assert module_of(a) in BRIDGE_ENDS[idt.split()[0]][0], (s, d, idt)
            rel = RELEASE_V2.get(cls, ("", "")) if TAG == "v2" else RELEASE[cls]
            if TAG == "v2" and cls == "b":
                ok, rel = False, ("", "")  # v2 replaces no embedded object by an id; needs a wire-analysis rule
            fix.update(fix_class=cls, fix=f"{idt}: {note}".strip(": "), release_34=rel[0],
                       release_40=rel[1], source="star", resolved="Y" if ok else "")
    rec.update(fix)
    rows.append(rec)

with open(os.path.join(RAW, f"crossing-edges{SFX}.csv"), "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=["check", "src", "dst", "src_label", "dst_label", "path", "experimental",
                                       "fix_class", "fix", "release_34", "release_40", "source", "resolved"])
    w.writeheader()
    for r in sorted(rows, key=lambda r: (r["check"], r["src_label"], r["dst_label"], r["src"], r["dst"])):
        w.writerow(r)

# ---------------------------------------------------------------- unit graphs, today and after the fixes
removed = {(r["src"], r["dst"], r["path"]) for r in rows if r["resolved"]}


def graph(after):
    g = defaultdict(set)
    for e in edges:
        a, b = place[e["src"]], place[e["dst"]]
        ua, ub = unit(a), unit(b)
        if ua in ("assembly", "retire") or ub in ("assembly", "retire"):
            continue
        if after and (e["src"], e["dst"], e["path"]) in removed:
            continue
        na = a if ua == "module:buying" else ua
        nb = b if ub == "module:buying" else ub
        if na != nb:
            g[na].add(nb)
    return g


def sccs(g):
    """Tarjan: strongly connected components with more than one node."""
    idx, low, stack, on, out, n = {}, {}, [], set(), [], [0]
    nodes = set(g) | {y for v in g.values() for y in v}

    def strong(v):
        idx[v] = low[v] = n[0]
        n[0] += 1
        stack.append(v)
        on.add(v)
        for w in g.get(v, ()):
            if w not in idx:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], idx[w])
        if low[v] == idx[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                out.append(sorted(comp))

    sys.setrecursionlimit(10000)
    for v in sorted(nodes):
        if v not in idx:
            strong(v)
    return out


def star_violations(g):
    bad = []
    for a, bs in g.items():
        for b in bs:
            ma, mb = unit(a), unit(b)
            if ma == mb:
                if ma == "module:buying" and layer_of(b) not in DEPS[layer_of(a)]:
                    bad.append((a, b, "layer"))
                continue
            if mb == "kernel":
                continue
            if ma.startswith("module:") and mb.startswith("module:"):
                bad.append((a, b, "module->module"))
            elif ma == "kernel":
                bad.append((a, b, "kernel->" + mb.split(":")[0]))
            elif ma.startswith("module:") and mb.startswith("extension:"):
                bad.append((a, b, "module->extension"))
            elif ma.startswith("extension:") and mb.startswith("module:"):
                if mb[7:] not in ext_ends(ma.split(":", 1)[1]):
                    bad.append((a, b, "extension->foreign-module"))
    return sorted(bad)


today, after = graph(False), graph(True)
cnt = Counter((r["check"], "resolved" if r["resolved"] else "unresolved") for r in rows)
by_fix = Counter((r["check"], r["fix_class"]) for r in rows)
fe = defaultdict(set)
for r in rows:
    fe[r["check"]].add((r["src"], r["dst"]))
unresolved = [r for r in rows if not r["resolved"]]
layer_rows = [r for r in rows if r["check"] == "layer"]

# ids each module uses to point at another module (from the resolved b/c/a-split fixes), and bridge points
ids_by_module = defaultdict(Counter)
for r in rows:
    if r["fix_class"] in ("b", "a-split", "c") and r["src_label"].startswith("module:"):
        ids_by_module[module_of(r["src_label"])][r["fix"].split(":")[0]] += 1

out = {
    "edges_total": len(edges),
    "crossing_occurrences": {f"{k[0]}|{k[1]}": v for k, v in sorted(cnt.items())},
    "crossing_file_edges": {k: len(v) for k, v in sorted(fe.items())},
    "by_fix_class": {f"{k[0]}|{k[1] or '-'}": v for k, v in sorted(by_fix.items())},
    "unresolved": [{k: r[k] for k in ("check", "src", "dst", "path", "src_label", "dst_label")} for r in unresolved],
    "layer_wrong_way_today": [{k: r[k] for k in ("src", "dst", "src_label", "dst_label", "path", "fix_class",
                                                 "release_34", "release_40")} for r in layer_rows],
    "star_violations_today": len([x for x in star_violations(today) if x[2] != "layer"]),
    "layer_violations_today": len([x for x in star_violations(today) if x[2] == "layer"]),
    "cycles_today": sccs(today),
    "star_violations_after": star_violations(after),
    "cycles_after": sccs(after),
    "unit_graph_after": {k: sorted(v) for k, v in sorted(after.items())},
    "ids_by_module": {m: dict(c.most_common()) for m, c in sorted(ids_by_module.items())},
}
dump(out, os.path.join(RAW, f"verify-final{SFX}.json"))
print("crossing occurrences:", out["crossing_occurrences"])
print("crossing file edges:", out["crossing_file_edges"])
print("unresolved:", len(unresolved))
for r in unresolved[:40]:
    print("   ", r["check"], r["src_label"], r["src"], "->", r["dst_label"], r["dst"], "@", r["path"])
print("unit-graph violations today:", out["star_violations_today"], "star,", out["layer_violations_today"], "layer")
print("cycles today:", out["cycles_today"])
print("violations after fixes:", out["star_violations_after"])
print("cycles after fixes:", out["cycles_after"])
