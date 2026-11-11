"""Write alternative placement files derived from the base placement.

Usage: python3 -I variants.py <base placement.json> <out dir>

  merged-media-buy.json  discovery folded into media-buy (one WG-owned media buy module)
  registries-assembled.json  shared registries (error codes, task types, notification
                         types, entity types, specialisms, metrics) become generated
                         assemblies of module fragments instead of kernel files
"""
import json
import os
import sys

base = json.load(open(sys.argv[1]))
out = sys.argv[2]
os.makedirs(out, exist_ok=True)

merged = {p: ("media-buy" if m == "discovery" else m) for p, m in base.items()}
json.dump(merged, open(os.path.join(out, "merged-media-buy.json"), "w"), indent=1, sort_keys=True)

REGISTRIES = {"enums/error-code.json", "core/x-entity-types.json", "enums/task-type.json",
              "enums/notification-type.json", "enums/specialism.json", "enums/available-metric.json"}
reg = {p: ("_registry" if p in REGISTRIES else m) for p, m in base.items()}
json.dump(reg, open(os.path.join(out, "registries-assembled.json"), "w"), indent=1, sort_keys=True)
print("wrote", out)

# Optional: the kernel-cut variant with error codes as a module-owned registry (the open-registry lint rule)
if len(sys.argv) > 3:
    cut29 = json.load(open(sys.argv[3]))
    cut29e = dict(cut29)
    cut29e["enums/error-code.json"] = {"label": "assembly", "reason": "A-registry (variant: module-owned error codes)"}
    json.dump(cut29e, open(os.path.join(out, "cut-29-error-codes-registry.json"), "w"), indent=1, sort_keys=True)
