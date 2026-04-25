---
---

docs(conformance, catalog): refresh universal-storyboards tables to match `static/compliance/source/universal/`

Both `docs/building/conformance.mdx` and `docs/building/compliance-catalog.mdx` had stale universal-storyboards tables. The actual `static/compliance/source/universal/` directory now contains 9 graded storyboards; the docs listed 5–7. Drift accumulated as new storyboards landed without back-filling the index pages.

**Adds (both files):**

- `webhook-emission` — outbound webhook conformance (idempotency_key + RFC 9421 webhook signing). Runs for any agent accepting `push_notification_config`. Has been universal since #2417 / 3.0; never indexed in the catalog tables.
- `pagination-integrity` — `cursor` ↔ `has_more` invariant. Recently landed; missing from both pages.

**Adds (compliance-catalog only):**

- `idempotency` — was missing entirely from the catalog table though present in conformance.mdx and shipped as universal in 3.0.
- `signed-requests` — added in #3077 to the conformance.mdx table; the parallel catalog entry was missed.

**Framing fix (compliance-catalog):** the lead-in said "Every agent runs every storyboard… regardless of which protocols or specialisms it claims," which is true in scope but confusing on capability-gated rows (`deterministic-testing`, `signed-requests`). Reworded to "every agent runs every storyboard, with a few capability-gated by an explicit `supported: true` advertisement" plus a closing paragraph noting that gated storyboards can't be partially implemented (advertise `false` if you don't ship the full surface).

No new normative content. The two index pages now reflect the same 9 universal storyboards in the same order, matching the published `/compliance/{version}/universal/` directory.
