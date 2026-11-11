"""Shared helpers for the final AdCP layout (analysis/final/). Stdlib only.

Paths, the buying layer order, schema loading, and $ref extraction with JSON pointers.
"""
import json
import os
import posixpath

HERE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS = os.path.dirname(HERE)
RAW = os.path.join(HERE, "raw")
# Frozen inputs from two analyses this directory doesn't ship: the buying-layers analysis (a layer for each
# buying file of the module cut, capability owners, commit verdicts) and the star analysis (one class per
# cross-module edge, and the placement that follows).
INPUTS = os.path.join(HERE, "inputs")
MODULE_CUT = os.path.join(ANALYSIS, "module-cut")
CHURN = os.path.join(ANALYSIS, "churn")

# Buying layers, bottom-up (a linearization of the layer DAG). Two pairs are siblings: pricing and
# catalogs (both depend on targeting only), and offer and execution (neither may refer to the other).
ORDER = ["targeting", "pricing", "catalogs", "commitment", "supply", "offer", "execution", "delivery"]
DEPS = {
    "targeting": [],
    "pricing": ["targeting"],
    "catalogs": ["targeting"],
    "commitment": ["targeting", "pricing"],
    "supply": ["targeting", "pricing", "catalogs", "commitment"],
    "offer": ["targeting", "pricing", "catalogs", "commitment", "supply"],
    "execution": ["targeting", "pricing", "catalogs", "commitment", "supply"],
    "delivery": ["targeting", "pricing", "catalogs", "commitment", "supply", "execution"],
}
RANK = {l: i for i, l in enumerate(ORDER)}

STANDARD_MODULES = ["buying", "creative", "governance", "reporting", "accounts", "signals",
                    "identity", "sponsored-intelligence", "trusted-match"]

# Bridge extensions. The star analysis defined 7 bridges (inputs/star_decisions.py BRIDGES); C2 and C7 each
# had two declaring modules, so the final layout splits them by declaring side and every bridge connects
# exactly two modules.
# id -> (extension name, declaring module, other module, kernel ids it uses)
BRIDGES = {
    "C1": ("governance-checks-on-buying", "governance", "buying", ["proposal_ref", "media_buy_ref"]),
    "C2a": ("reliable-reporting-account-attachments", "accounts", "reporting", ["account_ref"]),
    "C2b": ("reliable-reporting-delivery-revision", "buying", "reporting", ["media_buy_ref"]),
    "C3": ("creative-approvals-on-packages", "buying", "creative", ["creative_ref"]),
    "C4": ("format-declarations-on-products", "buying", "creative", ["format_kind_id", "format_option_ref"]),
    "C5": ("creative-signal-fanout", "creative", "signals", ["signal_ref"]),
    "C6": ("audience-evidence-on-products", "buying", "signals", ["signal_ref", "audience evidence pin"]),
    "C7a": ("content-artifacts-for-creative-evaluation", "creative", "governance", ["artifact_ref"]),
    "C7b": ("content-artifacts-for-context-match", "trusted-match", "governance", ["artifact_ref"]),
    # v2 (the wire analysis): bridges that keep today's embedded objects byte-identical
    "C8": ("account-details-on-buys", "buying", "accounts", ["account_ref"]),
    "C9": ("account-details-on-creatives", "creative", "accounts", ["account_ref"]),
    "C10": ("creative-delivery-metrics", "creative", "buying", ["creative_id", "metric_id"]),
    "C11": ("format-snapshots-for-context-match", "trusted-match", "buying", ["format_option_ref"]),
    "C12": ("creative-manifests-for-context-match", "trusted-match", "creative", ["creative_ref"]),
}
BRIDGE_NAMES = {k: v[0] for k, v in BRIDGES.items()}
BRIDGE_ENDS = {k: ({v[1]}, v[2]) for k, v in BRIDGES.items()}
V1_BRIDGES = ["C1", "C2a", "C2b", "C3", "C4", "C5", "C6", "C7a", "C7b"]

# FINAL_TAG=v2 selects the byte-preserving placement (placement-final-v2.json) and suffixes the outputs.
TAG = os.environ.get("FINAL_TAG", "")
SFX = f"-{TAG}" if TAG else ""


def bridge_id(star_id, declaring_module):
    """Star-analysis bridge id (C1..C7) + the declaring module -> final bridge id."""
    for bid, (_n, decl, _o, _i) in BRIDGES.items():
        if bid in ("C8", "C9", "C10", "C11", "C12"):
            continue
        if bid.rstrip("ab") == star_id and decl == declaring_module:
            return bid
    return star_id
LEAF = "compliance-testing"


def load(p):
    with open(p) as fh:
        return json.load(fh)


def dump(obj, p):
    with open(p, "w") as fh:
        json.dump(obj, fh, indent=1, sort_keys=True, ensure_ascii=False)
        fh.write("\n")


def is_kernel(l):
    return l in ("kernel", "kernel-types")


def module_of(label):
    """'module:buying/offer' -> 'buying'; 'module:creative' -> 'creative'; else None."""
    if not label.startswith("module:"):
        return None
    return label[7:].split("/", 1)[0]


def layer_of(label):
    return label.split("/", 1)[1] if label.startswith("module:buying/") else None


def load_schemas(src):
    files = {}
    for dp, _, fns in os.walk(src):
        for fn in fns:
            if fn.endswith(".json"):
                full = os.path.join(dp, fn)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                with open(full) as fh:
                    files[rel] = json.load(fh)
    return files


def resolve(ref, src_rel):
    target = ref.split("#", 1)[0]
    if not target:
        return None
    if target.startswith("/schemas/"):
        return target[len("/schemas/"):]
    if target.startswith("http"):
        p = target.split("/schemas/", 1)[1]
        return p.split("/", 1)[1]
    return posixpath.normpath(posixpath.join(posixpath.dirname(src_rel), target))


def ref_occurrences(files):
    """Every $ref occurrence between two distinct schema files: (src, dst, ptr, experimental_ptr)."""
    occ = []

    def walk(node, rel, ptr, exp):
        if isinstance(node, dict):
            if node.get("x-status") == "experimental":
                exp = ptr or "/"
            r = node.get("$ref")
            if isinstance(r, str):
                dst = resolve(r, rel)
                if dst and dst in files and dst != rel:
                    occ.append((rel, dst, ptr or "/", exp))
            for k, v in node.items():
                walk(v, rel, f"{ptr}/{k.replace('~', '~0').replace('/', '~1')}", exp)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, rel, f"{ptr}/{i}", exp)

    for rel, doc in files.items():
        if rel == "index.json":
            continue
        walk(doc, rel, "", "/" if isinstance(doc, dict) and doc.get("x-status") == "experimental" else None)
    return occ


def prop_path(ptr):
    """JSON pointer -> readable property path, for example /properties/a/items/properties/b -> a[].b"""
    parts = ptr.strip("/").split("/") if ptr != "/" else []
    out, i = [], 0
    while i < len(parts):
        p = parts[i]
        if p in ("properties", "patternProperties") and i + 1 < len(parts):
            out.append(parts[i + 1].replace("~1", "/").replace("~0", "~"))
            i += 2
            continue
        if p in ("$defs", "definitions") and i + 1 < len(parts):
            out.append("#" + parts[i + 1])
            i += 2
            continue
        if p in ("items", "prefixItems"):
            if out:
                out[-1] += "[]"
            else:
                out.append("[]")
        elif p == "additionalProperties":
            out.append("{*}")
        i += 1
    return ".".join(out) or "(root)"
