"""Quick non-additive change check for kernel and kernel-types files.

Usage: python3 -I kernel_churn.py <repo root> <raw dir> [since=2025-10-19] [ref=HEAD]
Reads <raw>/placement2.json. Writes <raw>/kernel_churn.json and prints a table.

For every commit that touched a kernel-layer file since <since> (following renames), it parses
the file before and after and flags changes that are not additive:
  property removed, enum value removed, field newly required, type changed, const changed,
  additionalProperties closed, $ref retargeted, pattern changed, length/number bounds tightened.
Documentation keys (description, title, examples, $comment, enumDescriptions, x-*) are ignored.
This is a heuristic: a flag means "look at it", not "this broke someone".
"""
import json
import subprocess
import sys

REPO, RAW = sys.argv[1], sys.argv[2]
SINCE = sys.argv[3] if len(sys.argv) > 3 else "2025-10-19"
REF = sys.argv[4] if len(sys.argv) > 4 else "HEAD"
place = json.load(open(f"{RAW}/placement2.json"))
SRC = "static/schemas/source/"
DOC_KEYS = {"description", "title", "examples", "$comment", "enumDescriptions", "default", "notes"}


def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True).stdout


def load(rev, path):
    out = subprocess.run(["git", "-C", REPO, "show", f"{rev}:{path}"], capture_output=True, text=True)
    if out.returncode:
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def facets(node, ptr="", acc=None):
    acc = {} if acc is None else acc
    if isinstance(node, dict):
        for k, v in node.items():
            if k in DOC_KEYS or k.startswith("x-"):
                continue
            p = f"{ptr}/{k}"
            if k in ("enum", "required") and isinstance(v, list):
                acc[p] = set(map(json.dumps, v))
            elif k in ("type", "const", "pattern", "$ref", "additionalProperties", "minLength", "maxLength",
                       "minimum", "maximum", "minItems", "maxItems", "format") and not isinstance(v, dict):
                acc[p] = v
            else:
                if k == "properties" and isinstance(v, dict):
                    for name in v:
                        acc[f"{p}/{name}#exists"] = True
                facets(v, p, acc)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            facets(v, f"{ptr}/{i}", acc)
    return acc


def diff(a, b):
    fa, fb = facets(a), facets(b)
    out = []
    for p, va in fa.items():
        vb = fb.get(p)
        key = p.rsplit("/", 1)[-1]
        if p.endswith("#exists"):
            if vb is None:
                out.append(("property-removed", p[:-7]))
            continue
        if key == "enum":
            if vb is None:
                out.append(("enum-removed", p))
            elif va - vb:
                out.append(("enum-value-removed", f"{p}: {sorted(va - vb)[:4]}"))
        elif key == "required":
            if vb is not None and vb - va:
                out.append(("newly-required", f"{p}: {sorted(vb - va)[:4]}"))
        elif vb is None:
            if key in ("type", "const", "$ref"):
                out.append((f"{key}-removed", p))
        elif va != vb:
            if key in ("minLength", "minimum", "minItems") and isinstance(va, (int, float)) and vb < va:
                continue
            if key in ("maxLength", "maximum", "maxItems") and isinstance(va, (int, float)) and vb > va:
                continue
            if key == "additionalProperties" and vb is not False:
                continue
            out.append((f"{key}-changed", f"{p}: {va!r} -> {vb!r}"))
    for p, vb in fb.items():
        key = p.rsplit("/", 1)[-1]
        if p not in fa and key == "required" and not any(q.startswith(p.rsplit("/", 1)[0] + "/") and q != p for q in fa):
            pass  # new object entirely: additive
        if p not in fa and key == "additionalProperties" and vb is False:
            out.append(("additionalProperties-closed", p))
        if p not in fa and key == "required" and p.rsplit("/", 1)[0] + "/properties" in {x.rsplit("/", 1)[0] for x in fa}:
            out.append(("newly-required", f"{p}: {sorted(vb)[:4]}"))
    return out


rows = {}
for f, v in sorted(place.items()):
    if v["label"] not in ("kernel", "kernel-types"):
        continue
    log = git("log", "--follow", f"--since={SINCE}", "--format=@%H %ad %s", "--date=short", "--name-only", REF, "--",
              SRC + f)
    commits, cur = [], None
    for line in log.splitlines():
        if line.startswith("@"):
            h, rest = line[1:].split(" ", 1)
            cur = {"sha": h, "date": rest[:10], "subject": rest[11:], "path": None}
            commits.append(cur)
        elif line.strip() and cur:
            cur["path"] = line.strip()
    flagged = []
    for c in commits:
        before = load(c["sha"] + "^", c["path"]) if c["path"] else None
        if before is None:
            # file created or renamed in this commit: try the renamed-from path via git log --follow ordering
            continue
        after = load(c["sha"], c["path"])
        if after is None:
            continue
        d = diff(before, after)
        if d:
            flagged.append({"sha": c["sha"][:10], "date": c["date"], "subject": c["subject"][:90], "changes": d[:6]})
    rows[f] = {"label": v["label"], "commits": len(commits), "non_additive_commits": len(flagged), "flagged": flagged}

json.dump(rows, open(f"{RAW}/kernel_churn.json", "w"), indent=1)
for f, r in rows.items():
    print(f"{r['label']:12s} {f:52s} commits={r['commits']:3d} non-additive={r['non_additive_commits']}")
    for fl in r["flagged"][:3]:
        print(f"      {fl['sha']} {fl['date']} {fl['subject'][:60]}  {fl['changes'][:2]}")
