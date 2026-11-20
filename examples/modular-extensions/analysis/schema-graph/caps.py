"""Quantify how many modules contribute to get-adcp-capabilities-response.json.

Usage: python3 -I caps.py <schemas/source dir> <raw dir>
"""
import json
import os
import sys
from collections import Counter, defaultdict

SRC, RAW = sys.argv[1], sys.argv[2]
F = "protocol/get-adcp-capabilities-response.json"
doc = json.load(open(os.path.join(SRC, F)))
place = json.load(open(os.path.join(RAW, "placement.json")))

BLOCK_MODULE = {
    "adcp": "protocol", "supported_protocols": "protocol", "specialisms": "protocol",
    "extensions_supported": "protocol", "experimental_features": "protocol",
    "last_updated": "protocol", "errors": "core", "context": "core", "ext": "core",
    "account": "account", "media_buy": "discovery+media-buy", "signals": "signals",
    "governance": "governance", "sponsored_intelligence": "x-sponsored-intelligence",
    "brand": "brand", "creative": "creative",
    "oauth": "identity", "request_signing": "identity", "webhook_signing": "identity",
    "identity": "identity",
    "measurement_gateway": "x-measurement", "measurement": "x-measurement",
    "compliance_testing": "x-compliance-testing",
    "wholesale_feed_versioning": "discovery", "wholesale_feed_webhooks": "discovery",
}


def refs(n, acc):
    if isinstance(n, dict):
        if isinstance(n.get("$ref"), str):
            acc.append(n["$ref"])
        for v in n.values():
            refs(v, acc)
    elif isinstance(n, list):
        for v in n:
            refs(v, acc)
    return acc


def count_exp(n):
    s = json.dumps(n)
    return s.count('"x-status": "experimental"')


rows = []
for k, v in doc["properties"].items():
    rs = refs(v, [])
    tgt = Counter(place.get(r.split("#")[0].replace("/schemas/", ""), "?") for r in rs if r.startswith("/schemas/"))
    rows.append({"block": k, "module": BLOCK_MODULE.get(k, "?"), "bytes": len(json.dumps(v)),
                 "experimental": count_exp(v), "ref_targets": dict(tgt)})

# adcp block sub-sections that belong to other modules
adcp_sub = {k: len(json.dumps(v)) for k, v in doc["properties"]["adcp"]["properties"].items()}

# cross-block allOf constraints
cross = []
for i, a in enumerate(doc["allOf"]):
    s = json.dumps(a)
    blocks = sorted({b for b in doc["properties"] if f'"{b}"' in s})
    cross.append({"i": i, "blocks": blocks})

all_refs = refs(doc, [])
tgt_all = Counter(place.get(r.split("#")[0].replace("/schemas/", ""), "?") for r in all_refs if r.startswith("/schemas/"))
mods = {r["module"] for r in rows}
out = {"blocks": rows, "adcp_subsections_bytes": adcp_sub, "allOf": cross,
       "ref_target_modules": dict(tgt_all), "total_bytes": len(json.dumps(doc))}
json.dump(out, open(os.path.join(RAW, "caps.json"), "w"), indent=1)

print("total bytes", out["total_bytes"], "top-level blocks", len(rows))
by_mod = defaultdict(int)
for r in rows:
    by_mod[r["module"]] += r["bytes"]
print("bytes by contributing module:")
for m, b in sorted(by_mod.items(), key=lambda kv: -kv[1]):
    print(f"  {m:26s} {b:7d}")
print("distinct contributing modules (inline blocks):", len(mods))
print("$ref target modules:", dict(tgt_all))
print("allOf constraints:", len(cross), "spanning >=2 blocks:", sum(1 for c in cross if len(c["blocks"]) >= 2))
for c in cross:
    print("   ", c)
print("experimental markers in caps:", count_exp(doc))
print("adcp sub-sections:", adcp_sub)
