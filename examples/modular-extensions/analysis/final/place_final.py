"""Final layout step 2: one placement for every schema file, merging the star analysis and the buying layers.

Usage: python3 -I -B place_final.py
Reads (read-only): inputs/star-placement.json, inputs/star_decisions.py, inputs/buying-layers-placement.json,
                   raw/edges.csv, raw/source.json
Writes raw/placement-final.json  {file: {label, reason, origin, cut_10?, buying_layers?}}
       raw/buying-new-layers.csv  the 59 buying files without a buying-layers layer (53 star moves + 6 added by #8103)
       raw/placement-summary.json counts by label and by reason

Labels: kernel | kernel-types | module:<m> | module:buying/<layer> | extension:<name> | assembly | retire.
origin: cut-10 (the module cut), star (moved by the star analysis), buying-layers (layered by the buying-layers
analysis), or final (a decision below). cut_10 keeps the module-cut label of a file the star analysis moved;
buying_layers keeps the layer the buying-layers analysis gave the file.

Decisions on top of the star analysis and the buying layers (reason codes start with F-):
  F-catalogs-layer      the 30 catalogs files stay in buying as the opt-in `catalogs` layer, a sibling of
                        pricing that depends on targeting only.
  F-W4-reference-type   placement-identity and collection-selector are reference formats; they join kernel
                        types (wrong-way pattern W4), so targeting no longer points up into supply.
  F-bridge-only         a star bridge target that only the declaring side uses moves into that bridge extension.
  F-star-into-buying/*  a file the star analysis moved into buying gets a layer by the buying-layers rules
                        (task owner, then graph).
  F-8103-offer          the #8103 proposal files that the graph can't place go to offer.
  F-new-sole-referrer   a file added to the tree after the star placement takes its referrers' label.
"""
import csv
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common_final import (BRIDGE_ENDS, BRIDGE_NAMES, DEPS, INPUTS, ORDER, RANK, RAW, bridge_id,  # noqa: E402
                          dump, load, module_of)

sys.path.insert(0, INPUTS)
import star_decisions as D  # noqa: E402

star = load(os.path.join(INPUTS, "star-placement.json"))
lpl = load(os.path.join(INPUTS, "buying-layers-placement.json"))
src = load(os.path.join(RAW, "source.json"))
edges = list(csv.DictReader(open(os.path.join(RAW, "edges.csv"))))
in_e = defaultdict(set)
for e in edges:
    in_e[e["dst"]].add(e["src"])
# Files added to the tree after the star placement: place each with its referrers' label (sole referrer label).
gone = sorted(set(star) - set(src["files"]))
assert not gone, f"files removed since the star placement: {gone}"
for f in sorted(set(src["files"]) - set(star)):
    labs = {star[s]["label"] for s in in_e[f] if s in star} - {"assembly"}
    assert len(labs) == 1, (f, labs)
    star[f] = {"label": labs.pop(), "reason": "F-new-sole-referrer"}

final = {}
for f, v in star.items():
    rec = {"label": v["label"], "reason": v["reason"],
           "origin": "star" if v["reason"].startswith("star-") else ("final" if v["reason"].startswith("F-") else "cut-10")}
    if "cut_10" in v:
        rec["cut_10"] = v["cut_10"]
    final[f] = rec

# ---------------------------------------------------------------- 1. layers for the buying files the buying-layers analysis placed
new_buying = []
for f, rec in final.items():
    if rec["label"] != "module:buying":
        continue
    if f in lpl:
        l = lpl[f]["layer"]
        rec.update(label=f"module:buying/{l}", origin="buying-layers", buying_layers=l,
                   reason=("F-catalogs-layer" if l == "catalogs" else f"layers-{lpl[f]['reason']}"))
    else:
        new_buying.append(f)

# ---------------------------------------------------------------- 2. W4: inventory reference formats -> kernel types
# placement-identity ({seller_agent, placement_id}) and collection-selector ({publisher_domain, collection_ids})
# are reference formats; targeting embeds them and supply defines them (pattern W4). Ids live in kernel types.
for f in ("core/placement-identity.json", "core/collection-selector.json"):
    final[f].update(label="kernel-types", reason="F-W4-reference-type", origin="final", buying_layers=lpl[f]["layer"])


# ---------------------------------------------------------------- 3. layers for the 59 buying files without one
TASK_RE = re.compile(r"^media-buy/(?P<task>[a-z-]+?)(-async-response-(working|submitted|input-required)"
                     r"|-request|-response|-rejected)\.json$")
TASK_LAYER = {"list-proposals": "offer", "request-proposals": "offer", "accept-proposal": "offer",
              "get-products": "supply", "create-media-buy": "execution", "get-media-buy-delivery": "delivery"}


def layer(f):
    lab = final[f]["label"]
    return lab.split("/", 1)[1] if lab.startswith("module:buying/") else None


assigned = {}
for f in new_buying:
    m = TASK_RE.match(f)
    if m and m.group("task") in TASK_LAYER:
        assigned[f] = (TASK_LAYER[m.group("task")], "F-star-into-buying/TASK-owner")
for f, (l, r) in assigned.items():
    final[f].update(label=f"module:buying/{l}", reason=r)
pending = [f for f in new_buying if f not in assigned]
for _ in range(20):  # the buying-layers graph rule: highest layer that every buying referrer may depend on
    changed = False
    for f in pending:
        refl = {layer(s) for s in in_e[f] if s != f and layer(s)}
        if not refl:
            continue
        cands = [l for l in ORDER if all(l == r or l in DEPS[r] for r in refl)]
        if not cands:
            continue
        low = max(cands, key=RANK.get)
        reason = "F-star-into-buying/G-sole-layer" if len(refl) == 1 else "F-star-into-buying/G-lowest-consumer"
        if final[f]["label"] != f"module:buying/{low}":
            final[f].update(label=f"module:buying/{low}", reason=reason)
            changed = True
    if not changed:
        break
for f in pending:
    if final[f]["label"] != "module:buying":
        continue
    if "cut_10" not in star[f]:  # added after the module cut and the buying layers (#8103): proposals
        final[f].update(label="module:buying/offer", reason="F-8103-offer")
    elif f.startswith("media-buy/acceptance-policy-") or f == "core/acceptance-policy-profile-ids.json":
        # seller acceptance policies: published with inventory; no buying file refers to them yet
        final[f].update(label="module:buying/supply", reason="F-star-into-buying/seller-policy-supply")
    else:
        final[f].update(label="module:buying/supply", reason="F-star-into-buying/default-supply")
for f in new_buying:
    final[f]["origin"] = final[f].get("origin", "star")

# ---------------------------------------------------------------- 4. bridge-only files move into their bridge
bridge_of = {dst: rule[2] for dst, rule in D.TARGET.items() if rule[0] == "c"}
for _ in range(5):
    changed = False
    for f, star_id in sorted(bridge_of.items()):
        if final[f]["label"].startswith("extension:"):
            continue
        home = module_of(final[f]["label"])
        users = {final[s]["label"] for s in in_e[f] if s != f} - {"assembly", "module:compliance-testing"}
        user_mods = {module_of(u) or u for u in users}
        decl = {u for u in user_mods if not u.startswith("extension:")}
        if len(decl) != 1:
            continue
        bid = bridge_id(star_id, next(iter(decl)))
        if bid not in BRIDGE_ENDS:
            continue
        declaring, other = BRIDGE_ENDS[bid]
        ext = f"extension:{BRIDGE_NAMES[bid]}"
        if home == other and user_mods <= (declaring | {ext}):
            final[f].update(label=ext, reason=f"F-bridge-only ({bid})", origin="final")
            changed = True
    if not changed:
        break

# ---------------------------------------------------------------- outputs
for f, rec in final.items():
    assert rec["label"] != "module:buying", f
    assert rec["label"] != "module:media-vocabulary", f
dump(final, os.path.join(RAW, "placement-final.json"))
with open(os.path.join(RAW, "buying-new-layers.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["file", "came_from", "star_reason", "layer", "final_reason", "buying_referrer_layers"])
    for f in sorted(new_buying, key=lambda x: (ORDER.index(layer(x)), x)):
        refl = sorted({layer(s) for s in in_e[f] if s != f and layer(s)}, key=ORDER.index)
        w.writerow([f, star[f].get("cut_10", "(added by #8103)"), star[f]["reason"].split(":")[0], layer(f),
                    final[f]["reason"], " ".join(refl)])
labels = Counter(r["label"] for r in final.values())
reasons = Counter(r["reason"].split(":")[0] for r in final.values())
mods = Counter((module_of(l) or l.split(":")[0] if not l.startswith("extension:") else "extension")
               for l in (r["label"] for r in final.values()))
summary = {"files": len(final), "by_label": dict(sorted(labels.items())), "by_reason": dict(reasons.most_common()),
           "by_unit": dict(mods.most_common()),
           "buying_layers": {l: labels[f"module:buying/{l}"] for l in ORDER},
           "buying_total": sum(labels[f"module:buying/{l}"] for l in ORDER),
           "new_buying_files": len(new_buying),
           "new_buying_by_layer": dict(Counter(layer(f) for f in new_buying)),
           "bridge_only_moves": sorted(f for f, r in final.items() if r["reason"].startswith("F-bridge-only"))}
dump(summary, os.path.join(RAW, "placement-summary.json"))
print({k: v for k, v in summary.items() if k != "by_reason"})
