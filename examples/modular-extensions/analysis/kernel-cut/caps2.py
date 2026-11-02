"""Split get-adcp-capabilities-response.json into per-owner fragments (cut 2 owners).

Usage: python3 -I caps2.py <schemas/source dir> <raw dir>
Writes <raw>/caps2.json: owner -> {paths, bytes, experimental markers}. Prints a table.
Owners use the labels in placement2.json; signing profiles are extension fragments.
"""
import json
import os
import sys
from collections import defaultdict

SRC, RAW = sys.argv[1], sys.argv[2]
doc = json.load(open(os.path.join(SRC, "protocol/get-adcp-capabilities-response.json")))
P = doc["properties"]
M = "module:"
TOP = {
    "supported_protocols": "kernel", "specialisms": "kernel", "extensions_supported": "kernel",
    "experimental_features": "kernel", "last_updated": "kernel", "errors": "kernel", "context": "kernel",
    "ext": "kernel", "oauth": "kernel",
    "request_signing": "extension:request-signing-rfc9421", "webhook_signing": "extension:webhook-signing",
    "identity": M + "agent-trust", "signals": M + "signals", "sponsored_intelligence": M + "sponsored-intelligence",
    "measurement": M + "measurement", "measurement_gateway": M + "measurement",
    "compliance_testing": M + "compliance-testing",
    "wholesale_feed_versioning": M + "products", "wholesale_feed_webhooks": M + "products",
}
SUB = {
    "adcp": {"principal": M + "principal", "governance_enforcement": M + "campaign-governance",
             "capability_changes": M + "notifications", "attestations": M + "agent-trust", "*": "kernel"},
    "account": {"change_feed": M + "account-change-feed", "*": M + "account"},
    "brand": {"description": M + "brand", "*": M + "brand-rights"},
    "creative": {"supported_formats": M + "formats", "*": M + "creative"},
    "governance": {"property_features": M + "governance-lists", "creative_features": M + "content-standards",
                   "*": M + "campaign-governance"},
    "media_buy": {
        "anonymous_discovery": M + "products", "acceptance_policy_discovery": M + "policy",
        "supported_pricing_models": M + "products", "buying_modes": M + "products",
        "measurement_terms_acceptance": M + "products", "availability_horizon": M + "products",
        "outcome_target": M + "products", "audience_targeting": M + "products", "portfolio": M + "products",
        "proposal_refinement": M + "proposal-negotiation", "supports_proposals": M + "proposal-negotiation",
        "supports_exclusive_product_ids": M + "proposal-negotiation",
        "reporting_delivery_methods": M + "delivery-reporting", "offline_delivery_protocols": M + "delivery-reporting",
        "reporting_delivery": M + "reliable-reporting", "performance_feedback": M + "measurement",
        "vendor_metric_optimization": M + "metrics", "supported_optimization_metrics": M + "metrics",
        "governance_aware": M + "campaign-governance", "content_standards": M + "content-standards",
        "audience_evidence": M + "audiences-events", "conversion_tracking": M + "audiences-events",
        "rights_attestations": M + "brand-rights",
        "frequency_capping": M + "targeting", "aggregate_frequency_capping": M + "targeting",
        "*": M + "media-buy"},
}

owners = defaultdict(lambda: {"paths": [], "bytes": 0, "experimental": 0})


def add(owner, path, node):
    s = json.dumps(node)
    o = owners[owner]
    o["paths"].append(path)
    o["bytes"] += len(s)
    o["experimental"] += s.count('"x-status": "experimental"')


for k, v in P.items():
    if k in SUB:
        sub = v.get("properties", {})
        rest = {kk: vv for kk, vv in v.items() if kk != "properties"}
        add(SUB[k]["*"], f"{k} (block shell)", rest)
        for sk, sv in sub.items():
            add(SUB[k].get(sk, SUB[k]["*"]), f"{k}.{sk}", sv)
    else:
        add(TOP.get(k, "kernel"), k, v)

# cross-block allOf rules -> owners they touch
rules = []
for i, a in enumerate(doc.get("allOf", [])):
    s = json.dumps(a)
    touched = sorted({TOP.get(b) or SUB.get(b, {}).get("*") for b in P if f'"{b}"' in s} - {None})
    rules.append({"i": i, "owners": touched})

out = {"total_bytes": len(json.dumps(doc)), "owners": dict(owners), "allOf": rules}
json.dump(out, open(os.path.join(RAW, "caps2.json"), "w"), indent=1)
print("total bytes", out["total_bytes"], "owners", len(owners))
for o, r in sorted(owners.items(), key=lambda kv: -kv[1]["bytes"]):
    print(f"  {o:40s} {r['bytes']:6d}  exp={r['experimental']:2d}  {', '.join(r['paths'])[:150]}")
print("allOf rules:", len(rules), "touching >=2 owners:", sum(1 for r in rules if len(r["owners"]) >= 2))
