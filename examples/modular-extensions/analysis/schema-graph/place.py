"""Place every schema file into a proposed module and check the module DAG.

Usage: python3 -I place.py <raw dir>

Domain-directory files (and core/ roots with no referrers) are anchored by
name rules. Every shared file (core/, enums/, pricing-options/, error-details/)
is then placed at the most specific module that all of its referrers can
depend on (the "meet" in the proposed DAG); if there is none, it falls to
`core`. Files are processed referrers-first (the file graph is acyclic).
Edges that go against the DAG are reported as violations (cuts to make).

Writes raw/placement.json, raw/violations.json, raw/proposed_matrix.md
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

RAW = sys.argv[1]
nodes = json.load(open(os.path.join(RAW, "nodes.json")))

# ---------------------------------------------------------------- proposed DAG
DAG = {
    "core": [],
    "protocol": ["core"],
    "identity": ["protocol"],
    "account": ["identity"],
    "brand": ["identity"],
    "creative": ["brand", "account"],
    "signals": ["protocol"],
    "inventory": ["creative", "identity"],
    "discovery": ["inventory", "signals", "account"],
    "media-buy": ["discovery"],
    "governance": ["media-buy"],
    # extension modules (may depend on anything stable, nothing stable depends on them)
    "x-reporting-delivery": ["media-buy"],
    "x-sponsored-intelligence": ["brand", "protocol"],
    "x-trusted-match": ["governance"],
    "x-compliance-testing": ["governance", "x-reporting-delivery"],
    # generated per release from every module's fragment; depends on all
    "_assembly": ["governance", "x-reporting-delivery", "x-sponsored-intelligence",
                  "x-trusted-match", "x-compliance-testing"],
}

def closure(m, cache={}):
    if m not in cache:
        s = {m}
        for d in DAG[m]:
            s |= closure(d)
        cache[m] = s
    return cache[m]


# ---------------------------------------------------------------- anchors
RULES = [
    # aggregators that ref every task response -> generated assembly
    (r"^protocol/get-adcp-capabilities-response\.json$", "_assembly"),
    (r"^core/(async-response-data|mcp-webhook-payload|tasks-get-response)\.json$", "_assembly"),
    (r"^protocol/get-task-status-response\.json$", "_assembly"),
    (r"^(_|index|manifest)", "_assembly"),
    (r"^(registries|extensions)/", "core"),
    # kernel: envelopes and cross-domain refs every payload carries
    (r"^core/(version-envelope|protocol-envelope|experimental-feature-id|account-ref|brand-ref|ext|context|error|push-notification-config)\.json$", "core"),
    (r"^content-standards/artifact\.json$", "creative"),
    (r"^media-buy/change-term", "discovery"),
    (r"^core/(app|destination|education|flight|hotel|job|real-estate|store|vehicle)-item\.json$", "@core/catalog.json"),
    # protocol / transport
    (r"^protocol/(get-adcp-capabilities-request|get-task-status-request|list-tasks|sync-agent-notification)", "protocol"),
    (r"^core/(tasks-|compact-task|push-notification|notification-config|agent-notification|webhook-|agent-webhook|capabilities-changed|version-envelope|protocol-envelope|experimental-feature-id)", "protocol"),
    # identity / security
    (r"^protocol/(sync|get)-principal", "identity"),
    (r"^trust/", "identity"),
    (r"^(adagents\.json|aao/)", "inventory"),
    (r"^core/(principal|agent-signing|agent-encryption|attestation|response-payload-jws|verification-token|identity-relying|operator-identity|authorized-agent|brand-response-authorization)", "identity"),
    # account
    (r"^account/", "account"),
    (r"^core/account", "account"),
    # brand
    (r"^(brand\.json|brand/)", "brand"),
    # creative
    (r"^(creative|formats)/", "creative"),
    (r"^media-buy/(build-creative|list-creative-formats)", "creative"),
    # signals
    (r"^signals/", "signals"),
    # discovery
    (r"^media-buy/(get-products|list-products|request-proposals|refine-proposals|decline-proposals|list-collections|product-|proposal-|acceptance-|commercial-terms|outcome-target|legacy-purchase)", "discovery"),
    (r"^pricing-options/", "discovery"),
    (r"^core/(wholesale-feed|registry-)", "discovery"),
    # reporting-delivery extension (experimental cluster)
    (r"^media-buy/(get-reporting-status|sync-reporting-)", "x-reporting-delivery"),
    (r"^core/(reporting-|agent-reporting-destination)", "x-reporting-delivery"),  # experimental files only (see below)
    # media buy
    (r"^media-buy/", "media-buy"),
    (r"^core/(indicators-changed|media-buy|package)\.json$", "media-buy"),
    # governance
    (r"^(governance|property|collection|content-standards)/", "governance"),
    # extensions
    (r"^(sponsored-intelligence|a2ui)/", "x-sponsored-intelligence"),
    (r"^trusted-match/", "x-trusted-match"),
    (r"^compliance/", "x-compliance-testing"),
]

SHARED_DIRS = {"core", "enums", "pricing-options", "error-details"}


def anchor(f):
    for rx, m in RULES:
        if re.search(rx, f):
            # shared-dir files are only anchored when they are roots or explicit
            return m
    return None


place = {}
for f in nodes:
    a = anchor(f)
    top = f.split("/")[0]
    if a == "x-reporting-delivery" and f.startswith("core/") and not nodes[f]["file_experimental"]:
        continue
    if a and (top not in SHARED_DIRS or f.startswith("core/") or f.startswith("pricing-options/")):
        place[f] = a

# ---------------------------------------------------------------- topo order (referrers first)
indeg = {f: len(n["in"]) for f, n in nodes.items()}
order, ready = [], [f for f, d in indeg.items() if d == 0]
while ready:
    f = ready.pop()
    order.append(f)
    for d in nodes[f]["out"]:
        indeg[d] -= 1
        if indeg[d] == 0:
            ready.append(d)
assert len(order) == len(nodes), "file graph has a cycle"

MODS = list(DAG)


def eff(m):
    return "core" if m == "core?orphan" else m




# lower bound: anchored modules reachable from f through unanchored files
lower = {}
for f in reversed(order):  # leaves first
    acc = set()
    for d in nodes[f]["out"]:
        if d in place:
            acc.add(place[d])
        else:
            acc |= lower[d]
    lower[f] = acc


def choose(users, deps):
    cands = [m for m in MODS if all(m in closure(u) for u in users)]
    ok = [m for m in cands if all(d in closure(m) for d in deps)]
    pool = ok or cands
    # most specific = the candidate whose closure contains all other candidates
    best = [c for c in pool if all(o in closure(c) for o in pool)]
    return (best[0] if best else "core"), bool(ok)


alias = {f: place.pop(f)[1:] for f in list(place) if place[f].startswith("@")}
conflicts = []
for f in order:
    if f in place:
        continue
    users = {eff(place[s]) for s in nodes[f]["in"] if s in place}
    users -= {"_assembly", "x-compliance-testing"}
    if not users:
        deps = {eff(m) for m in lower[f]} - {"core?orphan"}
        j = [m for m in MODS if all(d in closure(m) for d in deps)]
        j = [m for m in j if all(m in closure(o) for o in j)]
        place[f] = j[0] if (deps and j) else "core?orphan"
        continue
    deps = {eff(m) for m in lower[f]} - {"core?orphan"}
    place[f], ok = choose(users, deps)
    if not ok:
        conflicts.append(f)


for f, tgt in alias.items():
    place[f] = place[tgt]

viol = defaultdict(list)
mat = Counter()
for f, n in nodes.items():
    for d in n["out"]:
        a, b = eff(place[f]), eff(place[d])
        if a != b:
            mat[(a, b)] += 1
        if b not in closure(a):
            viol[f"{a} -> {b}"].append(f"{f} -> {d}")

json.dump(place, open(os.path.join(RAW, "placement.json"), "w"), indent=1, sort_keys=True)
json.dump(viol, open(os.path.join(RAW, "violations.json"), "w"), indent=1)

cnt = Counter(eff(v) for v in place.values())
print("files per proposed module:")
for m in MODS:
    src = Counter(f.split("/")[0] if "/" in f else f for f, v in place.items() if eff(v) == m)
    print(f"  {m:26s} {cnt[m]:4d}  from {dict(src.most_common(6))}")
print("orphans (no referrer, not anchored):", sum(1 for v in place.values() if v == "core?orphan"))
print("placement conflicts (users vs deps):", len(conflicts), conflicts[:10])
print("violations:")
for k, v in sorted(viol.items(), key=lambda kv: -len(kv[1])):
    print(f"  {k}: {len(v)}  e.g. {v[:3]}")

with open(os.path.join(RAW, "proposed_matrix.md"), "w") as fh:
    ms = [m for m in MODS if m != "_assembly"]
    fh.write("| from \\ to | " + " | ".join(ms) + " |\n")
    fh.write("|---" * (len(ms) + 1) + "|\n")
    for a in ms + ["_assembly"]:
        fh.write(f"| {a} | " + " | ".join(str(mat.get((a, b), "")) if a != b else "·" for b in ms) + " |\n")
