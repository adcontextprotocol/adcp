---
---

ci(storyboards): two pre-existing lint failures cleaned up

Two unrelated lint failures that pre-dated #3918 work but blocked clean local runs:

1. **`list_accounts` missing from storyboard-scoping classification.** `tests/lint-storyboard-scoping.test.cjs` enforces that every `HANDLER_MAP` task is classified in either `TENANT_SCOPED_TASKS` or `EXEMPT_FROM_LINT`. `list_accounts` was unclassified. It belongs in `EXEMPT_FROM_LINT` category (b) — global discovery for the caller. The request schema carries no scoping ID (it's the chicken-and-egg discovery call that produces the IDs other tasks consume), so requiring envelope-identity routing on it would be circular. Doc-comment expanded to explain the placement.

2. **Non-canonical error codes in the brand-not-found storyboard, and a matching reference-implementation fix.** `static/compliance/source/protocols/brand/index.yaml`'s `get_brand_identity_unknown` step asserted `allowed_values: ["REFERENCE_NOT_FOUND", "brand_not_found", "BRAND_NOT_FOUND", "NOT_FOUND"]` — three legacy / non-spec values "tolerated for back-compat" per the storyboard's own description. `lint-error-codes.cjs` correctly flagged them as not-in-canonical-enum. The spec already commits to `REFERENCE_NOT_FOUND` as the canonical brand-not-found fallback (per `error-handling.mdx`), and the storyboard exists to gate against agent drift — tolerating non-canonical codes inside the gate is exactly the storyboard-author drift that #3918 closed. Switched the assertion to a single `value: "REFERENCE_NOT_FOUND"`.

   The training-agent reference implementation was emitting `BRAND_NOT_FOUND` (with an in-code comment noting the conflict with `error-handling.mdx` and that "feedback was filed upstream to reconcile"). Updated `server/src/training-agent/brand-handlers.ts` to emit `REFERENCE_NOT_FOUND` with `field: "brand_id"`, matching the canonical fallback rule; updated the matching unit test in `tests/addie/brand-sandbox-tools.test.ts`; and tightened the brand-protocol error vocabulary in `skills/adcp-brand/SKILL.md` to point readers at `REFERENCE_NOT_FOUND` for brand / rights / pricing-option lookups (the rights/pricing handlers already emitted the canonical code; the SKILL was the only doc still naming the legacy three).
