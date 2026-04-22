---
"adcontextprotocol": minor
---

spec: promote PLAN_NOT_FOUND; collapse 11 custom \*_NOT_FOUND codes to REFERENCE_NOT_FOUND (#2704)

The uniform-response MUST from #2691 forbade sellers from minting custom
`*_NOT_FOUND` codes — typed parameters without a dedicated standard code
MUST use `REFERENCE_NOT_FOUND`. The spec itself was out of compliance:
12 custom codes appeared in task-reference pages while the normative
rule forbade them. This PR resolves the incoherence.

**Promoted to standard vocabulary:**
- `PLAN_NOT_FOUND` added to `error-code.json` with a uniform-response
  MUST clause parallel to `SIGNAL_NOT_FOUND` / `CREATIVE_NOT_FOUND`.
  Used across `report_plan_outcome`, `get_plan_audit_logs`, and
  `check_governance`; clear recovery path via `sync_plans`. Added to
  both the "Not-found precedence" enumeration and the "Uniform response
  for inaccessible references" MUST-list in `error-handling.mdx`.

**Collapsed to `REFERENCE_NOT_FOUND`:**
- `CHECK_NOT_FOUND`, `CAMPAIGN_NOT_FOUND` (report_plan_outcome)
- `BRAND_NOT_FOUND` (sync_plans)
- `STANDARDS_NOT_FOUND` (get/update_content_standards)
- `FORMAT_NOT_FOUND` (list_creative_formats, creative/specification)
- `AGENT_NOT_FOUND` (get_signals, signals/specification, list_creative_formats)
- `SIGNAL_AGENT_SEGMENT_NOT_FOUND` (activate_signal, get_signals)
- `SEGMENT_NOT_FOUND` (glossary)
- `AUDIENCE_NOT_FOUND` (sync_audiences)
- `CATALOG_NOT_FOUND` (sync_catalogs)
- `EVENT_SOURCE_NOT_FOUND` (log_event)

Each page now names the failed typed parameter in `error.field`. Zero of
the 11 appeared in JSON schemas, so this is a prose-level cleanup.

**Signals-spec auth-uniformity tightened:** `docs/signals/specification.mdx`
previously said "Private Signal Agents MUST return `AGENT_NOT_FOUND`
for unauthorized accounts." That rule now explicitly routes through
`REFERENCE_NOT_FOUND` — same response whether the agent exists or the
caller is unauthorized — preventing cross-tenant enumeration. No
behavior change for implementers already following the uniform-response
MUST.

**Array-parameter guidance added to `error-handling.mdx`:** when the
failing parameter is an array (e.g., `catalog_ids`, `format_ids`),
`error.field` names the array itself. Sellers MAY enumerate
unresolvable elements in `error.details` only when those elements were
supplied verbatim by the caller; they MUST NOT distinguish
"authorized-but-missing" from "exists-but-unauthorized" at the
element level.

**Glossary redirect:** `docs/reference/glossary.mdx` now lists all 11
removed codes under the `REFERENCE_NOT_FOUND` entry so searches for
the old names find migration guidance.

Release notes bullet added under rc.5 with implementer migration
guidance.
