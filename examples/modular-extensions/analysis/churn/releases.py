"""Classify schema changes between consecutive GA releases (what an implementer saw).

Usage: python3 -I releases.py <repo> <since YYYY-MM-DD> <raw dir> [until ISO date]

For every GA tag (vX.Y.Z) dated on or after <since>, the previous release is:
  - the previous GA tag of the same X.Y line, or
  - for the first GA tag of a line, the latest GA tag of an older line released
    before it.
Writes <raw dir>/releases.json and <raw dir>/release_changes.jsonl.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify import classify  # noqa: E402
from gitio import GA_RE, PREFIX, Blobs, git, parse_raw_line, rel, version_key  # noqa: E402

REPO, SINCE, RAW = sys.argv[1:4]
UNTIL = sys.argv[4] if len(sys.argv) > 4 else None  # ignore GA tags made after the pinned REF
blobs = Blobs(REPO)
ZERO = "0" * 40

ga = []
for t in git(REPO, "tag", "--list", "v*").split():
    if GA_RE.match(t):
        sha = git(REPO, "rev-list", "-n1", t).strip()
        date = git(REPO, "log", "-1", "--format=%cI", sha).strip()
        ga.append({"tag": t, "sha": sha, "date": date, "v": version_key(t)})
ga.sort(key=lambda x: x["v"])

releases = []
for i, r in enumerate(ga):
    if r["date"][:10] < SINCE or (UNTIL and r["date"] > UNTIL):
        continue
    line = r["v"][:2]
    same = [x for x in ga if x["v"][:2] == line and x["v"] < r["v"]]
    if same:
        prev = same[-1]
    else:
        older = [x for x in ga if x["v"][:2] < line and x["date"] <= r["date"]]
        prev = max(older, key=lambda x: x["date"]) if older else None
    releases.append({"tag": r["tag"], "sha": r["sha"], "date": r["date"],
                     "line": f"{line[0]}.{line[1]}", "prev": prev["tag"] if prev else None,
                     "prev_sha": prev["sha"] if prev else None})

out = open(os.path.join(RAW, "release_changes.jsonl"), "w")
for rel_ in releases:
    if not rel_["prev_sha"] or not git(REPO, "ls-tree", rel_["prev_sha"], PREFIX).strip():
        # no previous release, or the previous release predates the source tree
        rel_["n_files"] = None
        rel_["baseline_missing"] = True
        continue
    raw = git(REPO, "diff-tree", "-r", "-M", "--raw", "--no-abbrev", rel_["prev_sha"], rel_["sha"],
              "--", PREFIX)
    n = 0
    for line in raw.splitlines():
        f = parse_raw_line(line)
        if not f or not (f["old"].endswith(".json") or f["new"].endswith(".json")):
            continue
        st = f["status"]
        old, new = rel(f["old"]), rel(f["new"])
        if st == "R" and old is None:
            st = "A"
        if st == "R" and new is None:
            st = "D"
        a = blobs.json(f["old_blob"]) if f["old_blob"] != ZERO and old else None
        b = blobs.json(f["new_blob"]) if f["new_blob"] != ZERO and new else None
        recs = classify(blobs, st, old, new, a, b, rel_["prev_sha"], rel_["sha"])
        n += 1
        out.write(json.dumps({
            "tag": rel_["tag"], "status": st, "old": old, "new": new,
            "file_exp_old": isinstance(a, dict) and a.get("x-status") == "experimental",
            "file_exp_new": isinstance(b, dict) and b.get("x-status") == "experimental",
            "n_additive": sum(r["cls"] == "additive" for r in recs),
            "n_nonadditive": sum(r["cls"] == "non-additive" for r in recs),
            "n_annotation": sum(r["cls"] == "annotation" for r in recs),
            "kinds": sorted({r["kind"] for r in recs if r["cls"] == "non-additive"}),
            "caps_blocks": sorted({(r["cls"], blk) for r in recs
                                   for blk in (r.get("caps_blocks") or ["#root"])})
            if "caps_blocks" in (recs[0] if recs else {}) else [],
            # per-record view for sub-block owner maps: [cls, ptr, top-level blocks]
            "caps_recs": [[r["cls"], r["ptr"], r.get("caps_blocks") or []] for r in recs]
            if "caps_blocks" in (recs[0] if recs else {}) else [],
        }) + "\n")
    rel_["n_files"] = n
out.close()
blobs.close()
json.dump(releases, open(os.path.join(RAW, "releases.json"), "w"), indent=1)
print(f"releases: {len(releases)}", file=sys.stderr)
