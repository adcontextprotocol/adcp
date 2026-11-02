"""Heuristic structural diff for draft-07 JSON Schemas.

diff_schema(old, new) returns a list of change records:
    {"cls": "additive" | "non-additive" | "annotation",
     "kind": short machine label,
     "ptr": JSON pointer of the schema node where the change happens (new doc
            pointer when it exists, else old doc pointer),
     "detail": short human text,
     "exp": True when the node or one of its ancestors carries
            x-status: experimental (in the old or the new document)}

The walk compares schema nodes keyword by keyword. It does not resolve $ref,
does not reason about if/then/else semantics, and treats every combinator subschema
it cannot match as added or removed. See analysis/README.md, "Known limits".
"""

ANNOTATION_KEYS = {
    "description", "title", "examples", "example", "$comment", "deprecated",
    "readOnly", "writeOnly", "markdownDescription", "$id", "$schema",
    "contentMediaType", "contentEncoding", "enumDescriptions",
}
# keyword -> direction in which a larger value tightens the schema
LOWER_BOUNDS = {"minimum", "exclusiveMinimum", "minLength", "minItems",
                "minProperties", "minContains"}
UPPER_BOUNDS = {"maximum", "exclusiveMaximum", "maxLength", "maxItems",
                "maxProperties", "maxContains"}
SUBSCHEMA_MAP_KEYS = {"properties", "definitions", "$defs", "patternProperties",
                      "dependencies"}
CONDITIONAL_KEYS = {"if", "then", "else", "not", "propertyNames", "contains",
                    "additionalItems", "dependentSchemas", "dependentRequired"}
COMBINATORS = {"oneOf", "anyOf", "allOf"}
LOOSER_FORMATS = {("uri", "uri-template"), ("uri", "uri-reference"), ("uri", "iri"),
                  ("uri-reference", "uri-template"), ("email", "idn-email"), ("hostname", "idn-hostname")}
SCHEMA_KEYWORDS = {"type", "enum", "const", "properties", "required", "additionalProperties",
                   "items", "additionalItems", "contains", "patternProperties", "dependencies",
                   "propertyNames", "if", "then", "else", "not", "oneOf", "anyOf", "allOf",
                   "definitions", "$defs", "$ref", "default", "pattern", "format",
                   "multipleOf", "uniqueItems"} | LOWER_BOUNDS | UPPER_BOUNDS


def esc(k):
    return str(k).replace("~", "~0").replace("/", "~1")


def is_exp(node):
    return isinstance(node, dict) and node.get("x-status") == "experimental"


def strip_ann(node):
    """Node with annotation and x-* keys removed, recursively."""
    if isinstance(node, dict):
        return {k: strip_ann(v) for k, v in node.items()
                if k not in ANNOTATION_KEYS and not str(k).startswith("x-")}
    if isinstance(node, list):
        return [strip_ann(v) for v in node]
    return node


def types_of(node):
    t = node.get("type")
    if t is None:
        return None
    return set(t) if isinstance(t, list) else {t}


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def names_in(node, depth=0, acc=None):
    """Property names a constraint mentions (required lists, properties keys, dependency keys)."""
    acc = set() if acc is None else acc
    if depth > 6:
        return acc
    if isinstance(node, list):
        for v in node:
            names_in(v, depth + 1, acc)
    elif isinstance(node, dict):
        for k, v in node.items():
            if k == "required" and isinstance(v, list):
                acc |= {x for x in v if isinstance(x, str)}
            elif k in ("properties", "dependencies") and isinstance(v, dict):
                acc |= set(v)
                names_in(list(v.values()), depth + 1, acc)
            elif isinstance(v, (dict, list)) and k not in ANNOTATION_KEYS:
                names_in(v, depth + 1, acc)
    return acc


class Differ:
    def __init__(self):
        self.out = []
        self.np = set()

    def add(self, cls, kind, ptr, detail, exp):
        self.out.append({"cls": cls, "kind": kind, "ptr": ptr or "/",
                         "detail": detail, "exp": exp})

    # ------------------------------------------------------------------ nodes
    def node(self, a, b, ptr, exp):
        exp = exp or is_exp(a) or is_exp(b)
        if a == b:
            return
        if not isinstance(a, dict) or not isinstance(b, dict):
            # boolean schemas (true/false) or malformed nodes
            if a is True or a == {}:
                self.add("non-additive", "schema-tightened", ptr, f"{a!r} -> constrained", exp)
            elif b is True or b == {}:
                self.add("additive", "schema-loosened", ptr, f"-> {b!r}", exp)
            else:
                self.add("non-additive", "schema-replaced", ptr, "non-object schema changed", exp)
            return
        if strip_ann(a) == strip_ann(b):
            self.annotations(a, b, ptr, exp)
            return
        saved_np = self.np
        pa = a.get("properties") if isinstance(a.get("properties"), dict) else {}
        pb = b.get("properties") if isinstance(b.get("properties"), dict) else {}
        self.np = set(pb) - set(pa)
        try:
            self._node(a, b, ptr, exp)
        finally:
            self.np = saved_np

    def only_new(self, sub):
        """True when a newly added constraint only mentions properties added at this node."""
        names = names_in(sub)
        return bool(names) and bool(self.np) and names <= self.np

    def _node(self, a, b, ptr, exp):
        self.annotations(a, b, ptr, exp, shallow=True)
        keys = (set(a) | set(b)) - ANNOTATION_KEYS
        keys = {k for k in keys if not str(k).startswith("x-")}
        # union widening: old node became one branch of a new oneOf/anyOf
        for comb in ("oneOf", "anyOf"):
            if comb in b and comb not in a and isinstance(b[comb], list):
                resid = strip_ann({k: v for k, v in a.items() if not (k in b and b[k] == v)})
                if any(strip_ann(member) in (strip_ann(a), resid) or not any(
                        x["cls"] == "non-additive" for x in diff_schema(resid, member))
                       for member in b[comb] if isinstance(member, dict)):
                    self.add("additive", "widened-to-union", ptr, f"node became a branch of new {comb}", exp)
                    return
            if comb in a and comb not in b and isinstance(a[comb], list):
                if any(strip_ann(member) == strip_ann(b) for member in a[comb]):
                    self.add("non-additive", "narrowed-from-union", ptr, f"{comb} collapsed to one branch", exp)
                    return
        if "$ref" in keys:
            ra, rb = a.get("$ref"), b.get("$ref")
            if ra != rb:
                if ra is None:
                    self.add("non-additive", "ref-introduced", ptr, f"inline -> $ref {rb}", exp)
                elif rb is None:
                    self.add("non-additive", "ref-inlined", ptr, f"$ref {ra} -> inline", exp)
                else:
                    self.add("non-additive", "ref-target-changed", ptr, f"{ra} -> {rb}", exp)
                # do not also report keyword noise of a ref swap
                keys -= {"type", "properties", "required", "enum", "additionalProperties",
                         "items", "oneOf", "anyOf", "allOf", "pattern", "format", "const"}
            keys.discard("$ref")
        for k in sorted(keys, key=str):
            va, vb = a.get(k), b.get(k)
            if va == vb:
                continue
            p = f"{ptr}/{esc(k)}" if ptr != "/" else f"/{esc(k)}"
            if k == "type":
                self.type_change(a, b, ptr, exp)
            elif k in SUBSCHEMA_MAP_KEYS:
                self.subschema_map(k, va or {}, vb or {}, p, exp, a, b)
            elif k == "required":
                self.required(va or [], vb or [], ptr, exp, a, b)
            elif k == "enum":
                self.enum(va, vb, ptr, exp)
            elif k == "const":
                if va is None:
                    self.add("non-additive", "const-added", ptr, f"const {vb!r}", exp)
                elif vb is None:
                    self.add("additive", "const-removed", ptr, f"const {va!r} dropped", exp)
                else:
                    self.add("non-additive", "const-changed", ptr, f"{va!r} -> {vb!r}", exp)
            elif k == "additionalProperties":
                self.addl(va, vb, p, exp)
            elif k in LOWER_BOUNDS or k in UPPER_BOUNDS:
                self.bound(k, va, vb, ptr, exp)
            elif k in ("pattern", "format", "multipleOf", "uniqueItems"):
                if k == "format" and (va, vb) in LOOSER_FORMATS:
                    self.add("additive", "format-loosened", ptr, f"{va!r} -> {vb!r}", exp)
                elif va is None or va is False:
                    self.add("non-additive", f"{k}-added", ptr, f"{k} {vb!r}", exp)
                elif vb is None or vb is False:
                    self.add("additive", f"{k}-removed", ptr, f"{k} {va!r} dropped", exp)
                else:
                    self.add("non-additive", f"{k}-changed", ptr, f"{va!r} -> {vb!r}", exp)
            elif k == "items":
                if isinstance(va, list) or isinstance(vb, list):
                    self.subschemas("items", va if isinstance(va, list) else [va],
                              vb if isinstance(vb, list) else [vb], p, exp, tuple_mode=True)
                elif va is None:
                    self.add("non-additive", "items-added", ptr, "items constraint added", exp)
                elif vb is None:
                    self.add("additive", "items-removed", ptr, "items constraint dropped", exp)
                else:
                    self.node(va, vb, p, exp)
            elif k in COMBINATORS:
                self.combinator(k, va, vb, ptr, p, exp)
            elif k in CONDITIONAL_KEYS:
                if va is None and self.only_new({k: vb}):
                    self.add("additive", "constraint-on-new-property", ptr, f"{k} added (new properties only)", exp)
                elif va is None:
                    self.add("non-additive", "conditional-added", ptr, f"{k} added", exp)
                elif vb is None:
                    self.add("additive", "conditional-removed", ptr, f"{k} dropped", exp)
                elif k in ("then", "else", "not", "propertyNames", "contains", "additionalItems") \
                        and isinstance(va, dict) and isinstance(vb, dict) and k != "not":
                    self.node(va, vb, p, exp)
                else:
                    self.add("non-additive", "conditional-changed", ptr, f"{k} changed", exp)
            elif k == "default":
                self.add("non-additive", "default-changed", ptr, f"default {va!r} -> {vb!r}", exp)
            elif k in SCHEMA_KEYWORDS:
                self.add("non-additive", "other-keyword", ptr, f"{k} changed", exp)
            else:
                # not a draft-07 validation keyword (enumMetadata, discriminator,
                # adcp_version, registry listings, ...): validators ignore it
                self.add("annotation", "metadata", ptr, f"{k} changed", exp)

    # ------------------------------------------------------------- annotation
    def annotations(self, a, b, ptr, exp, shallow=False):
        """Report annotation changes. shallow=True only looks at this node's keys."""
        changed = []
        for k in sorted((set(a) | set(b)), key=str):
            if (k in ANNOTATION_KEYS or str(k).startswith("x-")) and a.get(k) != b.get(k):
                changed.append(k)
        if not shallow:
            # whole subtree differs only in annotations; one record per node is enough
            if not changed:
                changed = ["nested"]
        for k in changed:
            if k == "x-status":
                kind = f"x-status:{a.get('x-status')}->{b.get('x-status')}"
            elif k == "deprecated":
                kind = "deprecated"
            elif str(k).startswith("x-"):
                kind = "x-annotation"
            else:
                kind = "doc" if k != "nested" else "doc-nested"
            self.add("annotation", kind, ptr, f"{k} changed", exp)

    # ------------------------------------------------------------------ parts
    def type_change(self, a, b, ptr, exp):
        ta, tb = types_of(a), types_of(b)
        if ta is None:
            self.add("non-additive", "type-added", ptr, f"type -> {sorted(tb)}", exp)
        elif tb is None:
            self.add("additive", "type-removed", ptr, f"type {sorted(ta)} dropped", exp)
        elif tb >= ta or (ta == {"integer"} and "number" in tb):
            self.add("additive", "type-widened", ptr, f"{sorted(ta)} -> {sorted(tb)}", exp)
        else:
            self.add("non-additive", "type-changed", ptr, f"{sorted(ta)} -> {sorted(tb)}", exp)

    def subschema_map(self, k, ma, mb, p, exp, a, b):
        if not isinstance(ma, dict) or not isinstance(mb, dict):
            self.add("non-additive", "other-keyword", p, f"{k} schema changed", exp)
            return
        req_b = set(b.get("required") or []) if k == "properties" else set()
        for name in sorted(set(ma) | set(mb), key=str):
            q = f"{p}/{esc(name)}"
            if name not in ma:
                e = exp or is_exp(mb[name])
                if k == "properties":
                    if name in req_b and not a == {}:
                        # counted by required(); still report the property itself
                        self.add("additive", "property-added", q, f"new property {name} (required)", e)
                    else:
                        self.add("additive", "property-added", q, f"new optional property {name}", e)
                elif k in ("definitions", "$defs"):
                    self.add("additive", "definition-added", q, f"new definition {name}", e)
                elif k == "dependencies" and name in self.np:
                    self.add("additive", "constraint-on-new-property", q, f"dependency {name} added (new property)", e)
                elif k == "dependencies":
                    self.add("non-additive", "conditional-added", q, f"dependency {name} added", e)
                else:
                    self.add("additive", f"{k}-added", q, f"{name} added", e)
            elif name not in mb:
                e = exp or is_exp(ma[name])
                if k == "properties":
                    self.add("non-additive", "property-removed", q, f"property {name} removed", e)
                elif k in ("definitions", "$defs"):
                    self.add("non-additive", "definition-removed", q, f"definition {name} removed", e)
                elif k == "dependencies":
                    self.add("additive", "conditional-removed", q, f"dependency {name} dropped", e)
                else:
                    self.add("non-additive", f"{k}-removed", q, f"{name} removed", e)
            else:
                if k == "dependencies" and (isinstance(ma[name], list) or isinstance(mb[name], list)):
                    if ma[name] != mb[name]:
                        self.add("non-additive", "conditional-changed", q, f"dependency {name} changed", exp)
                    continue
                self.node(ma[name], mb[name], q, exp)

    def required(self, ra, rb, ptr, exp, a, b):
        sa, sb = set(ra), set(rb)
        props_a = set((a.get("properties") or {}).keys()) if isinstance(a.get("properties"), dict) else set()
        for n in sorted(sb - sa, key=str):
            new_prop = n not in props_a and a.get("properties") is not None
            self.add("non-additive", "required-added", ptr,
                     f"{n} now required" + (" (property is new)" if new_prop else ""), exp)
        for n in sorted(sa - sb, key=str):
            props_b = b.get("properties") if isinstance(b.get("properties"), dict) else {}
            if n in props_b or not props_b:
                self.add("additive", "required-removed", ptr, f"{n} no longer required", exp)
            # else: the property itself was removed; property-removed covers it

    def enum(self, ea, eb, ptr, exp):
        if ea is None:
            self.add("non-additive", "enum-added", ptr, f"enum constraint added ({len(eb)} values)", exp)
            return
        if eb is None:
            self.add("additive", "enum-removed", ptr, "enum constraint dropped", exp)
            return
        ka = {repr(v) for v in ea}
        kb = {repr(v) for v in eb}
        added = sorted(kb - ka)
        removed = sorted(ka - kb)
        if added:
            self.add("additive", "enum-value-added", ptr, "added " + ", ".join(added)[:300], exp)
        if removed:
            self.add("non-additive", "enum-value-removed", ptr, "removed " + ", ".join(removed)[:300], exp)
        if not added and not removed:
            self.add("annotation", "enum-reordered", ptr, "enum order changed", exp)

    def addl(self, va, vb, p, exp):
        def openish(v):
            return v is None or v is True or v == {}
        if openish(va) and vb is False:
            self.add("non-additive", "closed", p, "additionalProperties -> false", exp)
        elif va is False and openish(vb):
            self.add("additive", "opened", p, "additionalProperties false -> open", exp)
        elif openish(va) and openish(vb):
            self.add("annotation", "doc", p, "additionalProperties true <-> absent", exp)
        elif isinstance(va, dict) and isinstance(vb, dict):
            self.node(va, vb, p, exp)
        elif openish(va):
            self.add("non-additive", "addl-constrained", p, "additionalProperties schema added", exp)
        elif openish(vb):
            self.add("additive", "addl-loosened", p, "additionalProperties schema dropped", exp)
        else:
            self.add("non-additive", "other-keyword", p, "additionalProperties changed", exp)

    def bound(self, k, va, vb, ptr, exp):
        na, nb = num(va), num(vb)
        tighten = None
        if va is None:
            tighten = True
        elif vb is None:
            tighten = False
        elif na is not None and nb is not None:
            tighten = (nb > na) if k in LOWER_BOUNDS else (nb < na)
        if tighten is None:
            self.add("non-additive", "bound-changed", ptr, f"{k} {va!r} -> {vb!r}", exp)
        elif tighten:
            self.add("non-additive", "bound-tightened", ptr, f"{k} {va!r} -> {vb!r}", exp)
        else:
            self.add("additive", "bound-loosened", ptr, f"{k} {va!r} -> {vb!r}", exp)

    # ------------------------------------------------------------ combinators
    def combinator(self, k, va, vb, ptr, p, exp):
        if va is None:
            # new combinator on an existing node
            if k == "allOf" and self.only_new({"allOf": vb}):
                self.add("additive", "constraint-on-new-property", ptr, "allOf added (new properties only)", exp)
            elif k == "allOf":
                self.add("non-additive", "allOf-added", ptr, "allOf constraints added", exp)
            else:
                self.add("non-additive", f"{k}-introduced", ptr, f"{k} introduced", exp)
            return
        if vb is None:
            if k == "allOf":
                self.add("additive", "allOf-removed", ptr, "allOf constraints dropped", exp)
            else:
                self.add("non-additive", f"{k}-dropped", ptr, f"{k} dropped", exp)
            return
        if not isinstance(va, list) or not isinstance(vb, list):
            self.add("non-additive", "other-keyword", ptr, f"{k} schema changed", exp)
            return
        self.subschemas(k, va, vb, p, exp)

    def subschemas(self, k, va, vb, p, exp, tuple_mode=False):
        if tuple_mode:
            for i in range(max(len(va), len(vb))):
                q = f"{p}/{i}"
                if i >= len(va):
                    self.add("non-additive", "tuple-item-added", q, "tuple position added", exp)
                elif i >= len(vb):
                    self.add("additive", "tuple-item-removed", q, "tuple position dropped", exp)
                else:
                    self.node(va[i], vb[i], q, exp)
            return
        # match subschemas: identical, then $ref, then title, then discriminator const, then index
        ia, ib = list(range(len(va))), list(range(len(vb)))
        pairs = []

        def keyf(member, how):
            if not isinstance(member, dict):
                return None
            if how == "exact":
                return repr(strip_ann(member))
            if how == "ref":
                return member.get("$ref")
            if how == "title":
                return member.get("title")
            if how == "const":
                props = member.get("properties") or {}
                cs = tuple(sorted((n, repr(s.get("const"))) for n, s in props.items()
                                  if isinstance(s, dict) and "const" in s))
                return cs or None
            if how == "req":
                r = member.get("required")
                return tuple(sorted(r)) if r else None
        for how in ("exact", "ref", "title", "const", "req"):
            ka = {}
            for i in ia:
                kk = keyf(va[i], how)
                if kk is not None:
                    ka.setdefault(kk, []).append(i)
            for j in list(ib):
                kk = keyf(vb[j], how)
                if kk is not None and ka.get(kk):
                    i = ka[kk].pop(0)
                    ia.remove(i)
                    ib.remove(j)
                    pairs.append((i, j))
        # leftover subschemas: pair by position only when counts match
        if len(ia) == len(ib):
            pairs += list(zip(ia, ib))
            ia, ib = [], []
        for i, j in sorted(pairs, key=lambda x: x[1]):
            self.node(va[i], vb[j], f"{p}/{j}", exp)
        for j in ib:
            e = exp or is_exp(vb[j])
            if k == "allOf" and self.only_new(vb[j]):
                self.add("additive", "constraint-on-new-property", f"{p}/{j}", "allOf subschema on new properties only", e)
            elif k == "allOf":
                self.add("non-additive", "allOf-subschema-added", f"{p}/{j}", "allOf constraint added", e)
            else:
                self.add("additive", f"{k}-branch-added", f"{p}/{j}", f"new {k} branch", e)
        for i in ia:
            e = exp or is_exp(va[i])
            if k == "allOf":
                self.add("additive", "allOf-subschema-removed", f"{p}/{i}", "allOf constraint dropped", e)
            else:
                self.add("non-additive", f"{k}-branch-removed", f"{p}/{i}", f"{k} branch removed", e)


def diff_schema(old, new):
    d = Differ()
    d.node(old, new, "/", False)
    return d.out


def file_is_experimental(doc):
    return is_exp(doc)


def has_experimental(doc):
    """True when the document carries x-status: experimental anywhere."""
    if isinstance(doc, dict):
        if doc.get("x-status") == "experimental":
            return True
        return any(has_experimental(v) for v in doc.values())
    if isinstance(doc, list):
        return any(has_experimental(v) for v in doc)
    return False


def resolve_ptr(doc, ptr):
    """Return (found, node) for a JSON pointer."""
    if ptr in ("", "/"):
        return True, doc
    node = doc
    for part in ptr.lstrip("/").split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
        else:
            return False, None
    return True, node
