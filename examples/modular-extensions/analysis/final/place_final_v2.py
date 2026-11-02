"""Final layout v2: the placement that keeps every wire payload byte-identical (the wire analysis's minimal
alternatives).

Usage: python3 -I -B place_final_v2.py
Reads raw/placement-final.json (v1, kept for the internal appendix) and raw/edges.csv.
Writes raw/placement-final-v2.json, raw/placement-summary-v2.json, raw/moves-v2.csv.

Placement moves (reason codes start with F-v2-). The wire analysis lists, for each payload a v1 fix would change,
the alternative that keeps its bytes; these moves are the placement part of those alternatives:
  F-v2-accepted-record-supply   canonical-proposal and proposal-status: offer -> supply. Commit responses keep
                                `accepted_proposal`; offer and execution both compose a supply format.
  F-v2-action-vocab-commitment  canonical-media-buy-action, -fields, applicable-package-id: execution ->
                                commitment, with the rest of the change-right vocabulary.
  F-v2-commit-response-supply   media-buy-commitment-response: execution -> supply, so accept_proposal (offer)
                                and buy_products (execution) both compose it from below.
  F-v2-opportunity-commitment   opportunity-context: offer -> commitment; it $refs only kernel types.
  F-v2-property-kernel          core/property.json: supply -> kernel types; buying, governance, and
                                adagents.json use it, and it has no commits since v3.0.0.
  F-v2-acceptance-governance    the 4 acceptance-policy files: supply -> governance, their only user.
  F-v2-catalog-kernel           catalog.json and its closure: catalogs -> kernel types; buying, creative, and
                                TMP embed it inline.
"""
import csv
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common_final import ORDER, RAW, dump, load, module_of  # noqa: E402

V2_MOVES = {
    "core/canonical-proposal.json": ("module:buying/supply", "F-v2-accepted-record-supply"),
    "enums/proposal-status.json": ("module:buying/supply", "F-v2-accepted-record-supply"),
    "core/canonical-media-buy-action.json": ("module:buying/commitment", "F-v2-action-vocab-commitment"),
    "core/canonical-media-buy-action-fields.json": ("module:buying/commitment", "F-v2-action-vocab-commitment"),
    "core/applicable-package-id.json": ("module:buying/commitment", "F-v2-action-vocab-commitment"),
    "media-buy/media-buy-commitment-response.json": ("module:buying/supply", "F-v2-commit-response-supply"),
    "core/opportunity-context.json": ("module:buying/commitment", "F-v2-opportunity-commitment"),
    "core/property.json": ("kernel-types", "F-v2-property-kernel"),
    "media-buy/acceptance-policy-profile.json": ("module:governance", "F-v2-acceptance-governance"),
    "media-buy/acceptance-policy-rule.json": ("module:governance", "F-v2-acceptance-governance"),
    "media-buy/acceptance-policy-requirement.json": ("module:governance", "F-v2-acceptance-governance"),
    "media-buy/acceptance-policy-catalog.json": ("module:governance", "F-v2-acceptance-governance"),
    "core/catalog.json": ("kernel-types", "F-v2-catalog-kernel"),
    "core/catalog-field-mapping.json": ("kernel-types", "F-v2-catalog-kernel"),
    "enums/content-id-type.json": ("kernel-types", "F-v2-catalog-kernel"),
    "enums/update-frequency.json": ("kernel-types", "F-v2-catalog-kernel"),
}

v1 = load(os.path.join(RAW, "placement-final.json"))
v2 = {f: dict(r) for f, r in v1.items()}
rows = []
for f, (lab, reason) in V2_MOVES.items():
    old = v1[f]["label"]
    assert old != lab, f
    v2[f].update(label=lab, reason=reason, origin="final-v2", v1=old)
    rows.append([f, old, lab, reason])
dump(v2, os.path.join(RAW, "placement-final-v2.json"))
with open(os.path.join(RAW, "moves-v2.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["file", "v1_label", "v2_label", "reason"])
    w.writerows(sorted(rows, key=lambda r: (r[3], r[0])))

labels = Counter(r["label"] for r in v2.values())
units = Counter("extension" if l.startswith("extension:") else (module_of(l) or l) for l in labels.elements())
summary = {"files": len(v2), "by_label": dict(sorted(labels.items())), "by_unit": dict(units.most_common()),
           "buying_layers": {l: labels[f"module:buying/{l}"] for l in ORDER},
           "buying_total": sum(labels[f"module:buying/{l}"] for l in ORDER),
           "kernel_layer": labels["kernel"] + labels["kernel-types"], "moves": len(rows)}
dump(summary, os.path.join(RAW, "placement-summary-v2.json"))
print(summary)
