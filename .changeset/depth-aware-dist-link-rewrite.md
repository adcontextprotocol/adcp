---
---

ci(dist): make `rewrite-dist-links.sh` depth-aware for relative `../` paths (closes #3437)

`scripts/rewrite-dist-links.sh` previously rewrote one specific case (`../../static/` from a depth-1 source file). Other depths weren't covered — a doc at `docs/file.md` (depth 0) linking `../static/...` or at `docs/a/b/file.md` (depth 2) linking `../../../static/...` would silently render broken in the dist mirror.

Replaces the hard-coded sed rule with a node helper (`scripts/rewrite-dist-relative-links.mjs`) that:

- Computes the source file's depth-in-`docs/` from the dist path.
- Rewrites links whose `../` count equals `sourceDepth + 1` — the minimal escape of `docs/`. That's exactly the link that lands on a repo-root sibling (`static/`, `compliance/`, `signatures/`, etc.) when read from source and breaks under the +2-segment `dist/docs/<version>/` mirror.
- Adds two `../` segments to the rewritten links.
- Is idempotent: post-rewrite, the count is `sourceDepth + 3`, no longer matches the minimal-escape predicate, second pass is a no-op.
- Leaves over-escaping links (`count > sourceDepth + 1`, target outside the repo) untouched — those are source-side bugs, not papered over silently.

Adds `tests/rewrite-dist-relative-links.test.cjs` (10 cases: each depth, in-docs vs escape, multiple links per file, `href=`/inline-code lead-ins, idempotence, malformed-source).

Phase 1 of the script (absolute prefix rewrites for `/docs/`, `/schemas/latest/`, `/schemas/vN/`) is unchanged. Phase 2 (relative escape rewrite) is the new node helper.
