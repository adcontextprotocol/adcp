---
"adcontextprotocol": minor
---

Deprecates top-level `max_results` on `get_signals` and pins `pagination.max_results` precedence.

`get-signals-request.json` carried two independent pagination fields — a legacy top-level `max_results` (no cap, no default, predates the pagination envelope) and the standard `pagination` envelope (`pagination.max_results`, max: 100, default: 50). The schema was silent on which wins when both are present.

This change adds a MUST-level precedence rule: when both fields are present, agents MUST honor `pagination.max_results`. It also deprecates the top-level field with guidance for sellers receiving it without a pagination envelope. The top-level `max_results` will be removed in AdCP 4.0.

All other paginated read endpoints (`get_products`, `list_creatives`, `list_creative_formats`, `get-collection-list`, `get-property-list`, `get-media-buy-artifacts`, `tasks-list`) carry only `pagination` — this brings `get_signals` into alignment.

Non-breaking: adds description-level deprecation and normative prose. No type, structure, or required-field changes. Existing callers unaffected; sellers adding the conflict check gain new conformance grounding.
