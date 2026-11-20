"""Cut 2: place every schema file into kernel / kernel-types / module / extension / assembly / retire.

Usage: python3 -I place2.py <schemas/source dir> <raw dir>
Reads  <raw>/nodes.json (from ../build_graph.py).
Writes <raw>/placement2.json   file -> {"label", "reason"}
       <raw>/layers.json       label -> layer
       <raw>/violations2.json  edges that break the cut, grouped by label pair
       <raw>/module_matrix2.md module-level edge counts
       <raw>/modules2.json     per-label file lists, declared deps, used deps
Prints a summary.

Order of placement (first match wins):
  1. assembly   closed unions and registries that list every module (regenerated per release)
  2. retire     no $ref in-edge, not a task payload or root document, not named anywhere in
                docs/server/compliance (CHANGELOG and README excluded)
  3. kernel     bootstrap test (curated)
  4. kernel-types shared-schema test (curated, small)
  5. extension  files that exist only for an extension-classified feature
  6. module     anchored by directory or name rule
  7. module     shared file placed at the most specific module that every referrer depends on
                (bounded below by its own dependencies); if no single module works, it is
                reported as "unplaceable" and lands in the lowest common module named in FALLBACK.
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

SRC, RAW = sys.argv[1], sys.argv[2]
REPO = os.path.abspath(os.path.join(SRC, "../../.."))
nodes = json.load(open(os.path.join(RAW, "nodes.json")))

K, KT = "kernel", "kernel-types"

# ------------------------------------------------------------------ module DAG (declared deps)
# Every module implicitly depends on kernel + kernel-types.
DAG = {
    K: [],
    KT: [K],
    "module:notifications": [],
    "module:account": ["module:notifications"],
    "module:account-onboarding": ["module:account"],
    "module:account-change-feed": ["module:account"],
    "module:metrics": [],
    "module:formats": ["module:metrics"],
    "module:catalogs": ["module:metrics", "module:formats", "module:targeting"],
    "module:brand": ["module:formats"],
    "module:agent-trust": ["module:brand", "module:formats"],
    "module:principal": ["module:account", "module:agent-trust"],
    "module:inventory": ["module:brand", "module:formats", "module:agent-trust"],
    "module:targeting": ["module:inventory", "module:metrics"],
    "module:policy": [],
    "module:signals": ["module:account", "module:targeting", "module:policy"],
    "module:creative": ["module:formats", "module:brand", "module:account", "module:metrics", "module:signals",
                        "module:agent-trust", "module:inventory"],
    "module:brand-rights": ["module:creative"],
    "module:audiences-events": ["module:account", "module:signals", "module:metrics", "module:agent-trust",
                                "module:catalogs"],
    "module:products": ["module:targeting", "module:signals", "module:audiences-events", "module:catalogs",
                        "module:policy", "module:formats", "module:inventory"],
    "module:media-buy": ["module:products", "module:creative"],
    "module:proposal-negotiation": ["module:media-buy"],
    "module:delivery-reporting": ["module:media-buy"],
    "module:reliable-reporting": ["module:delivery-reporting", "module:account-onboarding", "module:principal"],
    "module:measurement": ["module:delivery-reporting"],
    "module:governance-lists": ["module:inventory"],
    "module:content-standards": ["module:creative", "module:governance-lists", "module:policy"],
    "module:campaign-governance": ["module:proposal-negotiation", "module:content-standards"],
    "module:sponsored-intelligence": ["module:brand"],
    "module:trusted-match": ["module:media-buy", "module:content-standards"],
    "module:compliance-testing": [],  # filled below: depends on every module
    # extensions: may depend on anything they attach to; nothing non-extension depends on them
    "extension:response-signing-jws": [],
    "extension:aao-verification-token": [],
    "extension:adcp-ext-namespace": ["module:proposal-negotiation"],
    "extension:spot-lifecycle": ["module:delivery-reporting"],
    "assembly": [],
    "retire": [],
}
MODULES = [m for m in DAG if m.startswith("module:")]
DAG["module:compliance-testing"] = [m for m in MODULES if m != "module:compliance-testing"]
DAG["assembly"] = [m for m in DAG if m not in ("assembly", "retire")]
DAG["retire"] = list(DAG["assembly"])


def closure(m, cache={}):
    if m not in cache:
        s = {m, K, KT}
        for d in DAG[m]:
            s |= closure(d)
        cache[m] = s
    return cache[m]


# ------------------------------------------------------------------ rules
def rx(*pats):
    return re.compile("^(" + "|".join(pats) + r")\.json$")


ASSEMBLY = [
    (rx("protocol/get-adcp-capabilities-response"), "A-caps-god-object"),
    (rx("core/async-response-data", "core/mcp-webhook-payload", "core/tasks-get-response",
        "protocol/get-task-status-response", "core/tasks-list-response", "protocol/list-tasks-response"),
     "A-closed-task-union"),
    (rx("index", "manifest.schema", "extensions/index"), "A-registry"),
    (rx("adagents"), "A-wellknown-document"),
    (rx("enums/task-type", "enums/notification-type", "enums/adcp-protocol", "enums/specialism",
        "core/x-entity-types"), "A-closed-module-enum"),
]

KERNEL = [
    (rx("core/protocol-envelope", "core/version-envelope", "core/context", "core/ext", "core/response"),
     "K-envelope"),
    (rx("core/error", "enums/error-code", "enums/error-scope", "core/warning", "core/warning-resource",
        "enums/warning-code", "error-details/(rate-limited|conflict|version-unsupported|authorization-required|"
        "agent-permission-denied|stale-response|vendor-error-codes)"), "K-error-model"),
    (rx("core/tasks-get-request", "core/tasks-list-request", "protocol/get-task-status-request",
        "protocol/list-tasks-request", "core/compact-task-(working|submitted|input-required)",
        "enums/task-status", "core/push-notification-config", "enums/sort-direction"), "K-task-lifecycle"),
    (rx("protocol/get-adcp-capabilities-request", "core/experimental-feature-id"), "K-capability-discovery"),
    (rx("enums/auth-scheme", "enums/webhook-security-method", "enums/request-signing-error-code",
        "core/agent-signing-key", "enums/http-method", "core/downstream-connection-requirement"),
     "K-auth-signature-extension-point"),
    (rx("extensions/extension-meta", "core/platform-extension-ref"), "K-extension-mechanism"),
]

KERNEL_TYPES = [
    (rx("core/account-ref", "core/operator-unit", "core/brand-ref", "core/brand-id"), "KT-reference"),
    (rx("core/format-id", "core/property-id", "core/signal-id"), "KT-reference"),
    (rx("core/duration", "core/date-range", "core/datetime-range", "core/iana-timezone", "core/locale-tag"),
     "KT-time-locale"),
    (rx("core/price"), "KT-money"),
    (rx("core/pagination-request", "core/pagination-response"), "KT-pagination"),
    (rx("core/property-list-ref", "core/collection-list-ref", "core/placement-ref", "core/signal-ref",
        "core/collection-ref", "core/installment-ref", "core/brand-key"), "KT-reference"),
    (rx("enums/channels", "enums/pricing-model"), "KT-vocabulary"),
    (rx("core/vendor-pricing-option", "core/signal-pricing"), "KT-vendor-pricing"),
]

EXTENSION_FILES = [
    (rx("core/response-payload-jws-envelope"), "extension:response-signing-jws", "X-signing-profile"),
    (rx("core/verification-token-claims"), "extension:aao-verification-token", "X-registry-vocabulary"),
    (rx("extensions/adcp"), "extension:adcp-ext-namespace", "X-existing-ext-namespace"),
    (rx("enums/spot-status"), "extension:spot-lifecycle", "X-market-variation"),
]

M = "module:"
MEET = "@meet"
MODULE_ANCHORS = [
    # unreferenced by $ref but named in docs: owner by name
    (rx("core/asset-group-vocabulary"), M + "formats"),
    (rx("core/truncation-sentinel"), M + "notifications"),
    (rx("enums/signal-source"), M + "signals"),
    (rx("error-details/reference-definition-changed"), M + "proposal-negotiation"),
    # left to the graph on purpose (shared vocabulary whose owner the referrers decide)
    (rx("core/account-authorization", "core/account-with-authorization", "core/account-identity-change(-preview)?",
        "core/operator-identity", "core/opportunity-context", "media-buy/change-term(-constraints)?",
        "media-buy/acceptance-context", "core/inventory-list-application", "core/hold-policy",
        "core/(canonical-)?reporting-capabilities", "core/measurement-readiness", "core/creative-brief",
        "core/creative-policy", "core/rights-constraint", "core/rights-attestation-evaluation",
        "core/(collection|collection-property|placement|placement-property|property|installment|installment-property|"
        "geo|keyword|catalog-item|creative)-delivery-metrics", "core/indicator(-.*)?", "core/media-buy-.*",
        "core/canonical-media-buy-action-fields", "core/package-.*", "enums/right-(type|use)"), MEET),
    # notifications (account/agent-level subscriptions, not the task-level push config)
    (rx("protocol/sync-agent-notification-configs-(request|response)", "core/agent-notification-config",
        "core/agent-notification-config-state", "core/notification-config", "core/webhook-challenge",
        "core/webhook-challenge-response", "core/agent-webhook-challenge", "core/webhook-activity-record",
        "core/capabilities-changed-webhook"), M + "notifications"),
    # account
    (rx("account/sync-accounts-(request|response)",
        "error-details/(account-setup-required|billing-not-supported|billing-not-permitted-for-agent)"),
     M + "account-onboarding"),
    (rx("account/list-account-changes-(request|response)", "core/account-change", "core/account-change-recorded-webhook"),
     M + "account-change-feed"),
    (rx("account/sync-governance-(request|response)"), M + "campaign-governance"),
    (rx("account/.*", "core/account", "enums/account-currency-mode", "core/account-status-changed-webhook", "core/account-timezone-capability",
        "error-details/account-moved", "core/business-entity", "core/canonical-account-ref"), M + "account"),
    # trust / identity
    (rx("trust/v1/.*", "core/attestation-.*", "core/agent-encryption-key"),
     M + "agent-trust"),
    (rx("protocol/(sync|get)-principal-(request|response)", "core/principal-.*", "enums/principal-kind"),
     M + "principal"),
    # brand
    (rx("brand/(acquire|get|update)-rights-.*", "brand/rights-.*", "brand/revocation-notification",
        "enums/rights-billing-period", "core/generation-credential"), M + "brand-rights"),
    (rx("brand", "brand/.*", "core/brand-response-authorization-result"), M + "brand"),
    # inventory
    (rx("aao/.*", "core/property", "core/property-ref", "core/property-tag",
        "core/publisher-property-selector", "core/placement", "core/placement-(definition|identity|presentation)",
        "core/canonical-placement", "core/collection", "core/collection-(distribution|selector)", "core/talent",
        "core/seller-agent-ref", "core/identifier", "enums/identifier-types"), M + "inventory"),
    # catalogs
    (rx("media-buy/sync-catalogs-.*", "core/catalog(-.*)?",
        "core/(app|destination|education|flight|hotel|job|real-estate|store|vehicle)-item", "core/offering(-asset-group)?",
        "enums/(catalog-(action|item-status)|content-id-type|update-frequency)"), M + "catalogs"),
    # formats
    (rx("formats/.*", "core/format", "core/format-option-ref", "core/canonical-format-.*", "core/format-shape-vocabulary",
        "core/product-format-declaration", "core/creative-operation-format-declaration", "core/assets/.*",
        "core/requirements/.*", "core/macro-.*", "core/reference-renderer", "enums/macro-.*", "enums/universal-macro", "registries/.*",
        "media-buy/list-creative-formats-(request|response)", "creative/list-creative-formats-(request|response)",
        "creative/asset-types/index", "creative/video-brief", "enums/(logo-slot|asset-content-type)",
        "error-details/(macro-resolution-failed|vast-version-mismatch)"), M + "formats"),
    # creative
    (rx("creative/.*", "media-buy/build-creative-.*", "core/creative-(asset|assets|assignment|filters|item|"
        "manifest|variant|variable|representation|representation-set|consumption|localization|localization-readback|"
        "approval-scope|revision-id)", "core/evaluator-spec",
        "content-standards/artifact", "error-details/creative-.*", "error-details/accessibility-violation"),
     M + "creative"),
    # signals
    (rx("signals/.*", "core/signal-(definition|definition-enrichment|filters|listing|modeling-disclosure|"
        "pricing-option|coverage-forecast|selection-group-rule)", "core/data-provider-signal-selector"),
     M + "signals"),
    # audiences and events
    (rx("media-buy/(sync-audiences|sync-event-sources|log-event)-.*",
        "core/audience-(member|source|evidence|evidence-pin|evidence-requirements|evidence-selection)",
        "core/event", "core/event-(custom-data|source-health|surface)", "error-details/audience-too-small"),
     M + "audiences-events"),
    # proposal negotiation
    (rx("media-buy/(request-proposals|refine-proposals|accept-proposal|decline-proposals)-.*",
        "media-buy/(proposal-.*|commercial-terms|legacy-purchase-continuation-input)",
        "core/(canonical-)?proposal", "enums/proposal-.*",
        "error-details/(requote-required|unsupported-refinement-dimension)"), M + "proposal-negotiation"),
    # policy vocabulary (incl. seller acceptance policies)
    (rx("governance/(policy-.*|attribute-definition)", "enums/policy-.*", "media-buy/acceptance-policy-.*",
        "core/acceptance-policy-profile-ids"), M + "policy"),
    # targeting dimensions and forecast vocabulary
    (rx("core/geo-.*", "core/get-geo-place-resolution-(request|response)", "core/postal-.*",
        "core/positive-postal-area-support", "core/frequency-cap(-.*)?", "core/daypart-target",
        "core/forecast-.*", "core/(canonical-)?forecast-point", "enums/(geo-level|metro-system|legacy-postal-system|"
        "postal-system|device-type|device-platform|day-of-week|forecast-.*|daypart-time-granularity)", "core/catchment", "core/demographic-.*"),
     M + "targeting"),
    # products / discovery
    (rx("media-buy/(get-products|list-products|list-collections)-.*", "media-buy/(get-products-rejected|"
        "get-products-targeting-resolution|product-.*|outcome-target)",
        "core/(canonical-)?product(-.*)?", "pricing-options/.*",
        "core/(canonical-)?pricing-option", "core/wholesale-feed-.*", "core/registry-.*",
        "core/(canonical-)?delivery-forecast", "core/targeting(-.*)?",
        "error-details/(execution-requirement-unmet|unsupported-targeting-dimension|budget-too-low|policy-violation)"),
     M + "products"),
    # reliable reporting (experimental cluster)
    (rx("media-buy/(get-reporting-status|sync-reporting-status|sync-reporting-receipts)-(request|response)",
        "core/agent-reporting-destination(-state)?", "enums/reporting-destination-setup-state",
        "enums/delivery-recipient-cloud", "core/delivery-recipient"), M + "reliable-reporting"),
    (rx("core/reporting-.*"), "@experimental:" + M + "reliable-reporting"),
    # metrics vocabulary (shared by formats, products, media-buy, reporting, creative, catalogs)
    (rx("core/delivery-metrics", "core/delivery-metric-aggregate", "core/placement-evidence",
        "core/canonical-reporting-commitment", "core/reporting-delivery-offering-id",
        "core/reporting-verification-profile-set", "core/missing-metric", "core/committed-metric",
        "core/(canonical-)?measurement-terms", "core/measurement-window", "core/vendor-metric-.*",
        "core/canonical-metric-qualifier", "core/(canonical-)?performance-standard",
        "core/outcome-measurement", "core/attribution-window", "enums/(available-metric|attribution-.*|completion-source|"
        "lift-dimension|viewability-standard|reach-unit|metric-type|event-type|performance-standard-metric|makegood-remedy|"
        "action-source)"),
     M + "metrics"),
    (rx("media-buy/get-media-buy-delivery-(request|response)", "media-buy/media-buy-delivery-webhook-result",
        "core/delivery-breakdown-controls", "core/reporting-webhook"), M + "delivery-reporting"),
    (rx("media-buy/provide-performance-feedback-(request|response)", "core/performance-feedback(-.*)?"),
     M + "measurement"),
    # media buy execution
    (rx("media-buy/.*", "core/media-buy", "core/canonical-media-buy-action", "core/package", "core/package-request",
        "core/indicators-changed-webhook", "core/impairment",
        "error-details/action-not-allowed"), M + "media-buy"),
    # governance
    (rx("property/.*", "collection/.*"), M + "governance-lists"),
    (rx("content-standards/.*"), M + "content-standards"),
    (rx("governance/.*", "error-details/governance-agent-not-accepted"), M + "campaign-governance"),
    (rx("sponsored-intelligence/.*", "a2ui/.*"), M + "sponsored-intelligence"),
    (rx("trusted-match/.*"), M + "trusted-match"),
    (rx("compliance/.*"), M + "compliance-testing"),
]

# Shared vocab that the graph places too low or too high gets an explicit owner here only
# when the referrer set is empty (no $ref) and the name says nothing.
ORPHAN_OWNER = {}


def match(rules, f):
    for r in rules:
        if r[0].match(f):
            return r[1:]
    return None


# ------------------------------------------------------------------ retire candidates
def is_payload(f):
    b = f.rsplit("/", 1)[-1]
    return bool(re.search(r"(request|response|webhook|payload|notification)\.json$", b)) or "/" not in f or "async-response" in b


def named_elsewhere(f):
    out = subprocess.run(
        ["grep", "-rlF", "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.git",
         "--exclude=CHANGELOG.md", "--exclude=README.md", f.rsplit("/", 1)[-1][:-len(".json")],
         os.path.join(REPO, "docs"), os.path.join(REPO, "server"), os.path.join(REPO, "static/compliance"),
         os.path.join(REPO, "scripts"), os.path.join(REPO, "tests")],
        capture_output=True, text=True).stdout.split()
    return [p for p in out if not p.endswith("static/schemas/source/index.json")]


place, reason = {}, {}
for f in nodes:
    a = match(ASSEMBLY, f)
    if a:
        place[f], reason[f] = "assembly", a[0]
        continue
    if not nodes[f]["in"] and not is_payload(f) and not named_elsewhere(f):
        place[f], reason[f] = "retire", "R-unreferenced"
        continue
    for rules, lab in ((KERNEL, K), (KERNEL_TYPES, KT)):
        a = match(rules, f)
        if a:
            place[f], reason[f] = lab, a[0]
            break
    if f in place:
        continue
    a = match(EXTENSION_FILES, f)
    if a:
        place[f], reason[f] = a[0], a[1]
        continue
    a = match(MODULE_ANCHORS, f)
    if a:
        lab = a[0]
        if lab == MEET:
            continue
        if lab.startswith("@experimental:"):
            if not nodes[f]["file_experimental"]:
                continue
            lab = lab.split(":", 1)[1]
        place[f], reason[f] = lab, "M-anchor"

# ------------------------------------------------------------------ topo order (referrers first)
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

lower = {}
for f in reversed(order):
    acc = set()
    for d in nodes[f]["out"]:
        if d in place:
            acc.add(place[d])
        else:
            acc |= lower[d]
    lower[f] = acc

LABELS = list(DAG)
SKIP_USERS = {"assembly", "retire", "module:compliance-testing"}

unplaceable = []
for f in order:
    if f in place:
        continue
    users = {place[s] for s in nodes[f]["in"] if s in place} - SKIP_USERS
    deps = {d for d in lower[f] - {K, KT} if not d.startswith("extension:")}
    if not users:
        # only referenced by aggregators or not at all: place at the lowest module that covers deps
        cands = [m for m in MODULES if all(d in closure(m) for d in deps)]
        best = [c for c in cands if all(c in closure(o) for o in cands)]
        if not deps:
            if not nodes[f]["in"] and not named_elsewhere(f):
                place[f], reason[f] = "retire", "R-unreferenced"
            else:
                place[f], reason[f] = KT, "KT-unowned"
        else:
            place[f], reason[f] = (best[0] if best else "module:compliance-testing"), "M-deps-only"
        continue
    cands = [m for m in LABELS if m.startswith(("module:", "extension:")) and all(m in closure(u) for u in users)]
    ok = [m for m in cands if all(d in closure(m) for d in deps)]
    maximal = [c for c in ok if not any(c in closure(o) and c != o for o in ok)]
    best = sorted(maximal, key=lambda c: (-len(closure(c)), c))
    if best:
        single = len(users) == 1
        place[f], reason[f] = best[0], ("M-sole-user" if single and best[0] in users else "M-meet")
    else:
        # no module is below every user: shared-schema candidate
        unplaceable.append((f, sorted(users), sorted(deps)))
        place[f], reason[f] = KT, "KT-graph-promoted"

# ------------------------------------------------------------------ layer map
def layer(lab):
    if lab in (K, KT):
        return "kernel"
    return lab.split(":")[0] if ":" in lab else lab


layers = {lab: layer(lab) for lab in sorted(set(place.values()) | set(DAG))}

# ------------------------------------------------------------------ verify the cut
viol = defaultdict(list)
mat = Counter()
for f, n in nodes.items():
    a = place[f]
    for d in n["out"]:
        b = place[d]
        if a != b:
            mat[(a, b)] += 1
        if a in (K, KT):
            ok = b in (K, KT)
        elif a.startswith("extension:"):
            ok = b in closure(a) or b in (K, KT) or b.startswith("module:")  # extensions may ref kernel + modules
            ok = ok and not (b.startswith("extension:") and b != a)
        elif a in ("assembly", "retire"):
            ok = True
        else:
            ok = b in closure(a)
        if not ok:
            viol[f"{a} -> {b}"].append(f"{f} -> {d}")

# module-level cycle check on *used* edges
used = defaultdict(set)
for (a, b) in mat:
    if a not in ("assembly", "retire"):
        used[a].add(b)


def sccs(vs, adj):
    idx, low, on, st, out, c = {}, {}, set(), [], [], [0]
    sys.setrecursionlimit(10000)

    def sc(v):
        idx[v] = low[v] = c[0]; c[0] += 1; st.append(v); on.add(v)
        for w in adj.get(v, ()):
            if w not in idx:
                sc(w); low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], idx[w])
        if low[v] == idx[v]:
            comp = []
            while True:
                w = st.pop(); on.discard(w); comp.append(w)
                if w == v:
                    break
            out.append(comp)
    for v in vs:
        if v not in idx:
            sc(v)
    return [c for c in out if len(c) > 1]


cyc = sccs(sorted(used), used)
mod_only = {a: {b for b in bs if b.startswith(("module:", "extension:"))} for a, bs in used.items()
            if a.startswith(("module:", "extension:"))}
cyc_mod = sccs(sorted(mod_only), mod_only)

# ------------------------------------------------------------------ write
json.dump({f: {"label": place[f], "reason": reason[f]} for f in sorted(place)},
          open(os.path.join(RAW, "placement2.json"), "w"), indent=1)
json.dump(layers, open(os.path.join(RAW, "layers.json"), "w"), indent=1, sort_keys=True)
json.dump({k: v for k, v in DAG.items() if k not in ("assembly", "retire")},
          open(os.path.join(RAW, "dag2.json"), "w"), indent=1)
json.dump({k: v for k, v in sorted(viol.items(), key=lambda kv: -len(kv[1]))},
          open(os.path.join(RAW, "violations2.json"), "w"), indent=1)
mods = {}
for lab in LABELS:
    fs = sorted(f for f in place if place[f] == lab)
    deps_used = sorted({b for (a, b), c in mat.items() if a == lab and b != lab})
    mods[lab] = {"files": fs, "count": len(fs), "declared_deps": DAG[lab] if lab not in ("assembly", "retire") else ["*"],
                 "used_deps": deps_used,
                 "in_from": sorted({a for (a, b), c in mat.items() if b == lab and a != lab})}
json.dump(mods, open(os.path.join(RAW, "modules2.json"), "w"), indent=1)
json.dump(unplaceable, open(os.path.join(RAW, "unplaceable2.json"), "w"), indent=1)

ms = [m for m in LABELS if m not in ("retire",)]
short = lambda m: m.replace("module:", "").replace("extension:", "x:")
with open(os.path.join(RAW, "module_matrix2.md"), "w") as fh:
    cols = [m for m in ms if any(mat.get((a, m)) for a in ms)]
    fh.write("| from \\ to | " + " | ".join(short(c) for c in cols) + " |\n")
    fh.write("|---" * (len(cols) + 1) + "|\n")
    for a in ms:
        fh.write(f"| {short(a)} | " + " | ".join(("·" if a == b else str(mat.get((a, b), ""))) for b in cols) + " |\n")

cnt = Counter(place.values())
print("files:", len(place))
for lab in LABELS:
    if cnt[lab]:
        rs = Counter(reason[f] for f in place if place[f] == lab)
        print(f"  {lab:38s} {cnt[lab]:4d}  {dict(rs)}")
print("by layer:", dict(Counter(layers[v] for v in place.values())))
print("unplaceable -> kernel-types (graph-promoted):", len(unplaceable))
for u in unplaceable:
    print("   ", u)
print("violations:", sum(len(v) for v in viol.values()))
for k, v in sorted(viol.items(), key=lambda kv: -len(kv[1])):
    print(f"  {k}: {len(v)}  e.g. {v[:4]}")
print("SCCs over used edges incl. kernel layer:", cyc)
print("SCCs over module/extension edges only:", cyc_mod)
json.dump({"with_kernel": cyc, "modules_only": cyc_mod}, open(os.path.join(RAW, "cycles2.json"), "w"), indent=1)
