"""Classify one schema file change into additive / non-additive / annotation records."""
import os

from gitio import PREFIX
from schemadiff import diff_schema, is_exp, resolve_ptr, strip_ann

REF_KINDS = {"ref-introduced", "ref-inlined", "ref-target-changed"}


def deref(blobs, node, path, rev, doc):
    """Resolve one level of $ref on node (file at `path` in `rev`). None if unresolvable."""
    if not isinstance(node, dict) or "$ref" not in node:
        return node
    ref = node["$ref"]
    target_path, _, frag = ref.partition("#")
    if target_path.startswith("/schemas/"):
        tp = target_path[len("/schemas/"):]
        if tp.startswith("v") and "/" in tp and tp.split("/")[0][1:].replace(".", "").isdigit():
            tp = tp.split("/", 1)[1]
        target = blobs.json(f"{rev}:{PREFIX}{tp}")
    elif target_path == "":
        target = doc
    else:
        tp = os.path.normpath(os.path.join(os.path.dirname(path), target_path))
        target = blobs.json(f"{rev}:{PREFIX}{tp}")
    if not isinstance(target, dict):
        return None
    if frag:
        found, target = resolve_ptr(target, frag)
        if not found:
            return None
    merged = dict(target)
    merged.pop("definitions", None)
    for k, v in node.items():
        if k != "$ref":
            merged[k] = v
    return merged


def refine_refs(blobs, recs, a, b, old, new, parent, sha):
    """Replace $ref swaps by the diff of what the refs resolve to (one level)."""
    out = []
    for r in recs:
        if r["kind"] not in REF_KINDS:
            out.append(r)
            continue
        fa, na = resolve_ptr(a, r["ptr"])
        fb, nb = resolve_ptr(b, r["ptr"])
        ra = deref(blobs, na, old, parent, a) if fa else None
        rb = deref(blobs, nb, new, sha, b) if fb else None
        if ra is None or rb is None or (isinstance(ra, dict) and "$ref" in ra) \
                or (isinstance(rb, dict) and "$ref" in rb):
            out.append(r)
            continue
        sub = diff_schema(ra, rb)
        cls = {x["cls"] for x in sub}
        if "non-additive" in cls:
            first = next(x for x in sub if x["cls"] == "non-additive")
            r = dict(r, detail=r["detail"] + f" [resolved: {first['kind']} {first['ptr']} {first['detail']}]")
            out.append(r)
        elif "additive" in cls:
            out.append(dict(r, cls="additive", kind="ref-refactor-widened",
                            detail=r["detail"] + " [resolved target only adds]"))
        else:
            out.append(dict(r, cls="annotation", kind="ref-refactor-equivalent",
                            detail=r["detail"] + " [resolved target equivalent]"))
    return out



COND_KEYS = ("not", "if", "oneOf", "anyOf", "allOf", "dependencies", "enum", "const",
             "patternProperties", "propertyNames")


def _composed_targets(blobs, node, path, rev, doc):
    """Resolved targets of the $ref subschemas in node.allOf (one level)."""
    out = []
    if not isinstance(node, dict) or not isinstance(node.get("allOf"), list):
        return out
    for member in node["allOf"]:
        if isinstance(member, dict) and "$ref" in member:
            t = deref(blobs, {"$ref": member["$ref"]}, path, rev, doc)
            if isinstance(t, dict):
                out.append((member["$ref"], t))
    return out


def _judge_subschema(target, host_old):
    """Classify adding `target` as an allOf subschema to a node that used to be host_old."""
    hp = (host_old or {}).get("properties") or {}
    hreq = set((host_old or {}).get("required") or [])
    reasons, adds = [], []
    for p, ps in (target.get("properties") or {}).items():
        if p not in hp:
            adds.append(p)
        elif strip_ann(hp[p]) != strip_ann(ps):
            sub = diff_schema(hp[p], ps)
            if any(x["cls"] == "non-additive" for x in sub):
                reasons.append(f"{p} redefined")
            elif any(x["cls"] == "additive" for x in sub):
                adds.append(p)
    newreq = set(target.get("required") or []) - hreq
    if newreq:
        reasons.append("requires " + ", ".join(sorted(newreq)))
    if target.get("additionalProperties") is False:
        reasons.append("closed")
    conds = [k for k in COND_KEYS if k in target]
    if conds:
        reasons.append("adds " + "/".join(conds))
    if reasons:
        return "non-additive", "; ".join(reasons)
    if adds:
        return "additive", "adds optional " + ", ".join(sorted(adds))[:200]
    return "annotation", "equivalent"


def refine_compose(blobs, recs, a, b, old, new, parent, sha):
    """Resolve allOf-$ref composition (envelope folding) one level deep."""
    out = []
    for r in recs:
        k = r["kind"]
        if k in ("allOf-added", "allOf-subschema-added"):
            if k == "allOf-added":
                host_ptr = r["ptr"]
                ok, host_new = resolve_ptr(b, host_ptr)
                members = host_new.get("allOf") if ok and isinstance(host_new, dict) else None
            else:
                host_ptr = r["ptr"].rsplit("/allOf/", 1)[0] or "/"
                ok, member = resolve_ptr(b, r["ptr"])
                members = [member] if ok else None
            okh, host_old = resolve_ptr(a, host_ptr)
            if not members or not okh or not all(isinstance(x, dict) and "$ref" in x for x in members):
                out.append(r)
                continue
            verdicts = []
            for member in members:
                t = deref(blobs, {"$ref": member["$ref"]}, new, sha, b)
                if not isinstance(t, dict):
                    verdicts = None
                    break
                verdicts.append((member["$ref"],) + _judge_subschema(t, host_old if isinstance(host_old, dict) else {}))
            if verdicts is None:
                out.append(r)
                continue
            classes = {v[1] for v in verdicts}
            detail = "; ".join(f"{v[0]}: {v[2]}" for v in verdicts)
            if "non-additive" in classes:
                out.append(dict(r, detail=f"composed {detail}"))
            elif "additive" in classes:
                out.append(dict(r, cls="additive", kind="allOf-ref-compose-additive", detail=f"composed {detail}"))
            else:
                out.append(dict(r, cls="annotation", kind="allOf-ref-compose-equivalent", detail=f"composed {detail}"))
        elif k == "property-removed" and "/properties/" in r["ptr"]:
            host_ptr, name = r["ptr"].rsplit("/properties/", 1)
            host_ptr = host_ptr or "/"
            name = name.replace("~1", "/").replace("~0", "~")
            okn, host_new = resolve_ptr(b, host_ptr)
            oko, host_old = resolve_ptr(a, host_ptr)
            moved = None
            if okn and oko and isinstance(host_old, dict):
                for ref, t in _composed_targets(blobs, host_new, new, sha, b):
                    tp = (t.get("properties") or {}).get(name)
                    if tp is not None:
                        oldp = (host_old.get("properties") or {}).get(name)
                        sub = diff_schema(oldp, tp) if oldp is not None else []
                        moved = (ref, {x["cls"] for x in sub})
                        break
            if moved is None:
                out.append(r)
            elif "non-additive" in moved[1]:
                out.append(dict(r, detail=r["detail"] + f" (moved into {moved[0]}, schema changed)"))
            else:
                out.append(dict(r, cls="annotation", kind="property-moved-to-composed",
                                detail=r["detail"] + f" (moved into {moved[0]})"))
        else:
            out.append(r)
    return out


CAPS = "protocol/get-adcp-capabilities-response.json"


def _blocks_in(node, depth=0, acc=None):
    """Top-level capability block names a cross-block rule (allOf subschema) mentions."""
    acc = set() if acc is None else acc
    if depth > 4 or not isinstance(node, (dict, list)):
        return acc
    if isinstance(node, list):
        for v in node:
            _blocks_in(v, depth, acc)
        return acc
    for k, v in node.items():
        if k == "properties" and isinstance(v, dict) and depth <= 2:
            acc |= set(v)
        if k == "required" and isinstance(v, list) and depth <= 2:
            acc |= {x for x in v if isinstance(x, str)}
        if isinstance(v, (dict, list)) and k not in ("description", "title"):
            _blocks_in(v, depth + 1, acc)
    return acc


def tag_caps_blocks(recs, a, b):
    """Attach `caps_blocks`: which top-level capability blocks a record touches."""
    for r in recs:
        parts = r["ptr"].strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "properties":
            r["caps_blocks"] = [parts[1].replace("~1", "/").replace("~0", "~")]
        elif parts and parts[0] == "allOf" and len(parts) >= 2:
            found = set()
            for doc in (b, a):
                ok, member = resolve_ptr(doc, "/allOf/" + parts[1]) if isinstance(doc, dict) else (False, None)
                if ok:
                    found |= _blocks_in(member)
            r["caps_blocks"] = sorted(found)
        elif parts == [""] and r["kind"] in ("required-added", "required-removed", "property-added",
                                             "property-removed"):
            r["caps_blocks"] = [r["detail"].split(" ")[0]]
        elif parts and parts[0] == "definitions":
            r["caps_blocks"] = ["#definitions"]
        else:
            r["caps_blocks"] = []
    return recs


def classify(blobs, st, old, new, a, b, parent_rev, rev):
    """Records for one file change. a/b are the parsed old/new documents (or None)."""
    recs = []
    if st in ("A", "C"):
        recs.append({"cls": "additive", "kind": "new-file", "ptr": "/", "detail": "new file",
                     "exp": is_exp(b)})
    elif st == "D":
        recs.append({"cls": "non-additive", "kind": "file-removed", "ptr": "/",
                     "detail": "file removed", "exp": is_exp(a)})
    else:
        if st == "R":
            recs.append({"cls": "non-additive", "kind": "file-moved", "ptr": "/",
                         "detail": f"{old} -> {new} (wire-compatible path change)",
                         "exp": is_exp(a) or is_exp(b)})
        if a == "__PARSE_ERROR__" or b == "__PARSE_ERROR__":
            recs.append({"cls": "non-additive", "kind": "parse-error", "ptr": "/",
                         "detail": "invalid JSON on one side", "exp": False})
        elif a is not None and b is not None:
            recs += refine_compose(blobs, refine_refs(blobs, diff_schema(a, b), a, b, old, new,
                                                      parent_rev, rev), a, b, old, new, parent_rev, rev)
    if CAPS in (old, new):
        tag_caps_blocks(recs, a if isinstance(a, dict) else None, b if isinstance(b, dict) else None)
    return recs
