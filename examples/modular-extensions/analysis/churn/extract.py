"""Extract and classify every schema file change on the first-parent history.

Usage: python3 -I extract.py <repo> <ref> <since YYYY-MM-DD> <raw dir> [milestones]

milestones: comma list name=tag marking GA releases that split the history
            into windows (default "3.0=v3.0.0,3.1=v3.1.0,3.2=v3.2.1").

Writes into <raw dir>:
  meta.json          ref, analysed sha, tags with their first-parent intro point
  commits.jsonl      one row per first-parent commit that touched schemas
  file_changes.jsonl one row per (commit, schema file) with classified changes
  renames.json       [sha, old, new] for every rename (used to follow paths)
"""
import bisect
import json
import os
import subprocess
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gitio import (PREFIX, Blobs, git, parse_raw_line, pr_number, rel,  # noqa: E402
                   version_key, GA_RE)
from schemadiff import has_experimental, is_exp, resolve_ptr  # noqa: E402
from classify import classify  # noqa: E402

REPO, REF, SINCE, RAW = sys.argv[1:5]
MILESTONES = [m.split("=") for m in
              (sys.argv[5] if len(sys.argv) > 5 else "3.0=v3.0.0,3.1=v3.1.0,3.2=v3.2.1").split(",")]
os.makedirs(RAW, exist_ok=True)

head = git(REPO, "rev-parse", REF).strip()
# full first-parent list, oldest first, so that intro points work for any tag
fp_all = git(REPO, "rev-list", "--first-parent", "--reverse", head).split()
fp_idx = {c: i for i, c in enumerate(fp_all)}


def is_ancestor(a, b):
    return subprocess.run(["git", "-C", REPO, "merge-base", "--is-ancestor", a, b]).returncode == 0


# ---------------------------------------------------------------- tags
tags = {}
for t in git(REPO, "tag", "--list", "v*").split():
    if version_key(t) is None:
        continue
    sha = git(REPO, "rev-list", "-n1", t).strip()
    date = git(REPO, "log", "-1", "--format=%cI", sha).strip()
    intro = None
    if is_ancestor(sha, head):
        # first first-parent commit that contains the tag (containment is monotonic)
        lo, hi = 0, len(fp_all) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if is_ancestor(sha, fp_all[mid]):
                hi = mid
            else:
                lo = mid + 1
        intro = lo
    tags[t] = {"sha": sha, "date": date, "ga": bool(GA_RE.match(t)),
               "intro_index": intro, "intro_sha": fp_all[intro] if intro is not None else None,
               "on_first_parent": sha in fp_idx}
print(f"tags: {len(tags)}", file=sys.stderr)

ms = [(name, tags[t]["intro_index"], t) for name, t in MILESTONES]


def window_label(idx):
    if idx <= ms[0][1]:
        return f"pre-{ms[0][0]}"
    for k in range(1, len(ms)):
        if idx <= ms[k][1]:
            return f"{ms[k-1][0]}->{ms[k][0]}"
    return f"{ms[-1][0]}->now"


ga_by_line = {}
for t, info in tags.items():
    if info["intro_index"] is None:
        continue
    v = version_key(t)
    line = f"{v[0]}.{v[1]}"
    ga_by_line.setdefault((line, info["ga"]), []).append((info["intro_index"], v, t))
for k in ga_by_line:
    ga_by_line[k].sort()


def released_tags_before(idx):
    """Latest GA tag per release line, and latest prerelease, contained in fp_all[idx-1]."""
    ga, pre = [], []
    for (line, is_ga), lst in ga_by_line.items():
        cands = [x for x in lst if x[0] <= idx - 1]
        if not cands:
            continue
        best = max(cands, key=lambda x: x[1])[2]
        (ga if is_ga else pre).append(best)
    return ga, pre


# ---------------------------------------------------------------- log
fmt = "@@%H|%P|%cI|%s"
log = git(REPO, "log", "--first-parent", "--diff-merges=first-parent", "-M", "--raw",
          "--no-abbrev", f"--format={fmt}", f"--since={SINCE}", head, "--", PREFIX)
commits = []
cur = None
for line in log.splitlines():
    if line.startswith("@@"):
        sha, parents, date, subject = line[2:].split("|", 3)
        cur = {"sha": sha, "parents": parents.split(), "date": date, "subject": subject, "files": []}
        commits.append(cur)
    elif line.startswith(":") and cur is not None:
        r = parse_raw_line(line)
        if r and (r["old"].endswith(".json") or r["new"].endswith(".json")):
            if rel(r["old"]) is None and rel(r["new"]) is None:
                continue
            cur["files"].append(r)
commits.reverse()
print(f"commits touching schemas: {len(commits)}", file=sys.stderr)

blobs = Blobs(REPO)
ZERO = "0" * 40
first_schema_commit = git(REPO, "log", "--first-parent", "--reverse", "--format=%H", head,
                          "--", PREFIX).split()[0]

renames = []
fc_out = open(os.path.join(RAW, "file_changes.jsonl"), "w")
cm_out = open(os.path.join(RAW, "commits.jsonl"), "w")
tag_doc_cache = {}


def tag_doc(tag, path):
    key = (tag, path)
    if key not in tag_doc_cache:
        d = blobs.json(f"{tags[tag]['sha']}:{PREFIX}{path}")
        tag_doc_cache[key] = d if isinstance(d, (dict, list)) else None
    return tag_doc_cache[key]


def existed_in(tag, path, alt_paths, rec, old_doc):
    """Did the element this non-additive change touches exist in the released `tag`?"""
    doc = None
    for p in [path] + alt_paths:
        doc = tag_doc(tag, p)
        if doc is not None:
            break
    if doc is None:
        return False
    kind = rec["kind"]
    if kind in ("file-removed", "file-moved"):
        return True
    ptr = rec["ptr"]
    # constraint additions: ask whether the host node was released, not the new subschema
    for marker in ("/allOf/", "/anyOf/", "/oneOf/", "/dependencies/"):
        if rec["kind"].endswith("-added") or rec["kind"] in ("conditional-changed",):
            if marker in ptr and not ptr.rsplit(marker, 1)[1].count("/"):
                ptr = ptr.rsplit(marker, 1)[0] or "/"
    found, node = resolve_ptr(doc, ptr)
    if not found:
        return False
    if kind == "enum-value-removed" and isinstance(node, dict):
        vals = {repr(v) for v in node.get("enum") or []}
        removed = rec["detail"][len("removed "):].split(", ")
        return any(v in vals for v in removed)
    if kind == "required-added" and isinstance(node, dict):
        # a break only if the release had the field and did not already require it
        name = rec["detail"].split(" ")[0]
        return name in (node.get("properties") or {}) and name not in (node.get("required") or [])
    return True


# reverse rename chain: new path -> older names, built incrementally (oldest first)
older_names = {}

for c in commits:
    idx = fp_idx[c["sha"]]
    ga_tags, pre_tags = released_tags_before(idx)
    is_boot = c["sha"] == first_schema_commit
    statuses = Counter()
    for f in c["files"]:
        st = f["status"]
        old, new = rel(f["old"]), rel(f["new"])
        if st == "R" and old is None:
            st = "A"
        if st == "R" and new is None:
            st = "D"
        statuses[st] += 1
        a = blobs.json(f["old_blob"]) if f["old_blob"] != ZERO and old else None
        b = blobs.json(f["new_blob"]) if f["new_blob"] != ZERO and new else None
        if st == "R":
            renames.append([c["sha"], old, new])
            older_names[new] = [old] + older_names.get(old, [])
        recs = classify(blobs, st, old, new, a, b, c["parents"][0], c["sha"])
        path_for_release = old or new
        for r in recs:
            if r["cls"] == "non-additive" and ga_tags + pre_tags:
                alts = older_names.get(path_for_release, [])
                r["in_ga"] = [t for t in ga_tags if existed_in(t, path_for_release, alts, r, a)]
                r["in_pre"] = [t for t in pre_tags if existed_in(t, path_for_release, alts, r, a)]
        cnt = Counter(r["cls"] for r in recs)
        referrers = None
        if st == "D":
            # who referenced the removed file just before; used to place it later
            g = subprocess.run(["git", "-C", REPO, "grep", "-l", "-F", f"/schemas/{old}",
                                c["parents"][0], "--", PREFIX], capture_output=True, text=True)
            referrers = sorted({ln.split(":", 1)[1][len(PREFIX):] for ln in g.stdout.splitlines()
                                if ":" in ln} - {old})
        row = {
            "referrers": referrers,
            "sha": c["sha"], "status": st, "old": old, "new": new, "score": f["score"],
            "file_exp_old": is_exp(a) if isinstance(a, dict) else False,
            "file_exp_new": is_exp(b) if isinstance(b, dict) else False,
            "has_exp": (has_experimental(a) if isinstance(a, (dict, list)) else False)
            or (has_experimental(b) if isinstance(b, (dict, list)) else False),
            "n_additive": cnt["additive"], "n_nonadditive": cnt["non-additive"],
            "n_annotation": cnt["annotation"], "records": recs,
        }
        fc_out.write(json.dumps(row) + "\n")
    cm_out.write(json.dumps({
        "sha": c["sha"], "date": c["date"], "subject": c["subject"], "pr": pr_number(c["subject"]),
        "merge": len(c["parents"]) > 1, "fp_index": idx, "window": window_label(idx),
        "bootstrap": is_boot, "n_files": len(c["files"]), "statuses": dict(statuses),
        "ga_before": ga_tags, "pre_before": pre_tags,
    }) + "\n")

fc_out.close()
cm_out.close()
json.dump(renames, open(os.path.join(RAW, "renames.json"), "w"), indent=0)

# current tree (for path resolution in the aggregation step)
tree = [p[len(PREFIX):] for p in git(REPO, "ls-tree", "-r", "--name-only", head, PREFIX).split("\n")
        if p.endswith(".json")]
# schema-level experimental markers at HEAD
exp_now = {}
for p in tree:
    d = blobs.json(f"{head}:{PREFIX}{p}")
    exp_now[p] = {"file_exp": is_exp(d) if isinstance(d, dict) else False,
                  "has_exp": has_experimental(d) if isinstance(d, (dict, list)) else False}
blobs.close()
json.dump({"repo": os.path.basename(os.path.abspath(REPO)), "ref": REF, "head": head, "since": SINCE,
           "milestones": [{"name": n, "tag": t, "intro_index": i} for n, i, t in ms],
           "fp_head_index": fp_idx[head], "tags": tags, "tree": tree, "experimental_now": exp_now},
          open(os.path.join(RAW, "meta.json"), "w"), indent=1)
print("done", file=sys.stderr)
