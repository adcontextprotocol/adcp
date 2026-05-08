---
---

ci(release): docs-snapshot link rewriter preserves api-reference, forward-merge auto-resolves storyboard-schema.

Two release-tooling fixes that surfaced during the 3.0.7 cut:

**Snapshot link rewriter — leave api-reference alone.** `scripts/rewrite-dist-links.sh` was rewriting every `]( /docs/<section>/api-reference/<page>)` link to `]( /dist/docs/<version>/<section>/api-reference/<page>)`. OpenAPI-generated pages aren't included in snapshots — Mintlify generates them at runtime against `static/openapi/*.yaml` — so the rewritten links resolved to 404 in the version-pinned snapshot. Phase 1b now undoes the rewrite for any `/api-reference/` path, routing those links back to the live tree. Snapshotted prose pages still pin to their version; api-reference always flows through to current OpenAPI.

Also fixes 4 stale `aao-verified` links in live docs (`/docs/building/aao-verified` → `/docs/building/verification/aao-verified` — the canonical path; the short form was returning a 308 redirect that broke `mintlify broken-links`) and the corresponding rewrites in the 3.0.7 snapshot, plus the post-tag `domain-lookup` link removal that hadn't propagated into the snapshot.

**Forward-merge auto-resolves `storyboard-schema.yaml`.** The file is the doc-comment authoring schema. 3.0.x's clean-merged additions (`default_agent` in #3897, `provides_state_for` in #3734) merge automatically; the only conflict is main's CANONICAL CHECK ENUM block at the bottom of the file, which 3.0.x doesn't have. `--ours` keeps main's enum block AND preserves 3.0.x's upper additions. Verified manually on PRs #3902 (3.0.5), the 3.0.6 forward-merge attempts, and #4225 (3.0.7) — promoted to the allowlist after the third repeat.

Refs #4225.
