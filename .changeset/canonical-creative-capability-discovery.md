---
"adcontextprotocol": minor
---

Make canonical creative formats the AdCP 3.2 authoring and discovery path. Creative agents now advertise stable `creative.supported_formats[].capability_id` entries and required `operations` through `get_adcp_capabilities`; `build_creative` and `list_transformers` select those capabilities with string IDs; and the registry supports reverse discovery by canonical format, publisher format option, and creative operation.

Deprecate `list_creative_formats`, compound named format IDs, and format-attached transformer I/O throughout the schemas and current documentation while retaining explicit 3.x compatibility branches. Sales agents declare deliverability on `Product.format_options[]`, publishers declare acceptance in `adagents.json.formats[]`, and portable creative manifests continue to carry `format_kind` plus an optional `format_option_ref` rather than agent-local capability identity. Add normative multi-placement eligibility guidance and reusable canonical classification vectors.

Make publisher catalog freshness observable: `publisher.adagents_changed` now covers semantic changes in every top-level `adagents.json` field, including formats-only and placements-only revisions, and new events populate `changed_fields` plus format and placement counts. Clarify that the registry publisher lookup—not the origin-only `validateAdAgents()` path—provides the community-catalog fallback and its provenance.
