---
---

Extend Addie's "Spec Feedback Response Pattern" with a coverage-leading clause:
when `search_docs` / `get_schema` reveal that a proposed RFC overlaps with
existing primitives (or extends a field that doesn't exist), the reply MUST
open with what's already covered before drafting. `draft_github_issue` is
not called in the same turn as the verification — Addie sends the
coverage-leading reply first, then offers to draft a narrower scope on
confirmation. Validated against Jeffrey Mayer's 2026-05-01 RFC drafts
(CPQ pricing, TMP signals, bilateral trust, brand.json verification) — all
4 scenarios go from inconsistent drafting to 12/12 runs with zero premature
draft emission.
